"""Saving, copying and validating recorded clips.

WHY NOT `file_storage.save_image()`
-----------------------------------
That interface is image-shaped in three ways that are each fatal here: it
validates the filename against ALLOWED_IMAGE_EXTENSIONS, it pushes the bytes
through Pillow and re-encodes them to JPEG, and it returns a PUBLIC URL. A
video handed to it fails at `Image.open()` with "the uploaded file isn't a
valid image". This module follows `private_storage` instead, for exactly the
reasons that module's own header gives about playbook PDFs.

THE CONTAINER IS CHECKED, NOT THE FILENAME
------------------------------------------
An extension is a claim by the client, and so is the multipart Content-Type;
neither is evidence. An MP4 is an ISO base media file, which means the four
bytes at offset 4 are `ftyp`. That is what is verified, because it is the one
signal the client cannot get wrong by accident and cannot forge without
actually sending an MP4.

Rejecting anything else is not defence in depth for its own sake: the player
side has no fallback. A file that is not really H.264 MP4 produces a blank
rectangle on somebody's phone with no error anywhere, which is precisely the
failure the whole format decision exists to avoid.
"""

from __future__ import annotations

from flask import current_app

from app.errors import ApiError
from app.services.private_storage import get_private_storage

#: The only container V1 stores. The Phase 0 spike measured Chrome and Edge
#: producing this natively when asked for it explicitly, so nothing here ever
#: needs to transcode.
CLIP_CONTENT_TYPE = "video/mp4"
CLIP_EXTENSION = "mp4"

#: Captured in the browser at record time. WebP because it measured at roughly
#: half the JPEG for the same frame, and the coach upload path already accepts
#: WebP so nothing new had to learn about it.
POSTER_CONTENT_TYPE = "image/webp"
POSTER_EXTENSION = "webp"

#: Generous next to the ~0.15 MB/10s the spike measured, because that used
#: synthetic motion and real film compresses worse. Small enough that a runaway
#: 4K capture is still refused.
DEFAULT_CLIP_MAX_BYTES = 25 * 1024 * 1024
DEFAULT_POSTER_MAX_BYTES = 2 * 1024 * 1024

#: 15s cap plus slack for the browser overshooting its own auto-stop by a
#: frame or two. A clip claiming an hour is a bug or an attack, not a coach.
MAX_DURATION_MS = 20_000


def _clip_max_bytes() -> int:
    return int(current_app.config.get("CLIP_MAX_UPLOAD_BYTES", DEFAULT_CLIP_MAX_BYTES))


def looks_like_mp4(data: bytes) -> bool:
    """True when `data` begins with an ISO base media file header.

    Bytes 4-8 of an MP4 are the `ftyp` box type. Checked positionally rather
    than by searching, so a WebM with the letters "ftyp" somewhere in a
    metadata string cannot pass.
    """
    return len(data) >= 12 and data[4:8] == b"ftyp"


def _looks_like_webp(data: bytes) -> bool:
    return len(data) >= 12 and data[0:4] == b"RIFF" and data[8:12] == b"WEBP"


def validate_clip_bytes(data: bytes) -> None:
    """Raises ApiError unless `data` is a plausibly real, in-budget MP4."""
    if not data:
        raise ApiError("No clip data received", status_code=400)

    limit = _clip_max_bytes()
    if len(data) > limit:
        raise ApiError(
            f"That clip is too large. The limit is {limit // (1024 * 1024)} MB.",
            status_code=413,
        )

    if not looks_like_mp4(data):
        # Deliberately specific. The one way to reach this in normal use is a
        # browser that fell back to WebM, and a coach told "unsupported file"
        # would have no idea what to do about it.
        raise ApiError(
            "That recording isn't an MP4 video. Record Clip needs a browser "
            "that can record MP4 (H.264) - update Chrome or Edge and try again.",
            status_code=400,
        )


def validate_poster_bytes(data: bytes) -> None:
    if len(data) > DEFAULT_POSTER_MAX_BYTES:
        raise ApiError("That poster image is too large.", status_code=413)
    if not _looks_like_webp(data):
        raise ApiError("The clip's poster frame isn't a valid WebP image.", status_code=400)


def validate_duration_ms(duration_ms: int | None) -> int | None:
    if duration_ms is None:
        return None
    try:
        value = int(duration_ms)
    except (TypeError, ValueError):
        return None
    if value <= 0 or value > MAX_DURATION_MS:
        raise ApiError("That clip is longer than Record Clip allows.", status_code=400)
    return value


def save_clip(data: bytes) -> str:
    """Stores the video and returns its opaque private key."""
    validate_clip_bytes(data)
    return get_private_storage().save_private(
        data, content_type=CLIP_CONTENT_TYPE, extension=CLIP_EXTENSION
    )


def save_poster(data: bytes) -> str:
    validate_poster_bytes(data)
    return get_private_storage().save_private(
        data, content_type=POSTER_CONTENT_TYPE, extension=POSTER_EXTENSION
    )


def load_clip(key: str) -> bytes | None:
    return get_private_storage().load_private(key)


def delete_clip_object(key: str) -> None:
    """Removes a stored object.

    ONLY FOR UNDOING A FAILED WRITE. Nothing in the normal lifecycle deletes a
    clip: replacing one leaves the old object in place because a delivered
    snapshot may name it, and history outranks reclaiming a megabyte. This
    exists so a create that rolls back does not leave bytes nobody references
    - those bytes were never delivered to anyone, so there is no history to
    protect.
    """
    try:
        get_private_storage().delete_private(key)
    except Exception:
        # Best effort. A failed cleanup leaves an unreferenced object, which is
        # untidy; raising here would replace the coach's real error with a
        # storage one and tell them nothing useful.
        pass


def copy_clip_object(key: str) -> str:
    """Duplicates the stored bytes under a NEW key.

    ITS OWN OBJECT, NOT A SECOND REFERENCE - the same rule duplicate-quiz
    already applies to images, and for the same measured reason: every delete
    path assumes a single owner, so a shared key means the first destructive
    edit on either copy blanks the other. Proven in both directions for images
    before it was fixed; there is no reason to relearn it for clips.
    """
    data = get_private_storage().load_private(key)
    if data is None:
        raise ApiError("The original clip is missing from storage", status_code=502)
    return get_private_storage().save_private(
        data, content_type=CLIP_CONTENT_TYPE, extension=CLIP_EXTENSION
    )


def copy_poster_object(key: str | None) -> str | None:
    if key is None:
        return None
    data = get_private_storage().load_private(key)
    if data is None:
        # A missing poster is survivable - the video still plays and every
        # consumer already handles a clip without one. Failing the whole
        # duplicate over it would be worse than the thing it prevents.
        return None
    return get_private_storage().save_private(
        data, content_type=POSTER_CONTENT_TYPE, extension=POSTER_EXTENSION
    )
