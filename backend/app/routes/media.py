"""Signed-URL delivery of protected renders.

No JWT. The token IS the credential - which is not a weakening, but the only
mechanism that works: a player has no account, and a browser cannot attach an
Authorization header to an `<img src>` regardless. See
services/signed_media.py for the token design and why it carries a version
prefix from day one.

WHAT THIS ENDPOINT CAN REACH
----------------------------
Page rasters, thumbnails, masked page renders, recorded clips and their
posters - live and as-delivered. That is the complete list, and it is enforced
by construction: `sign_media_token` refuses to mint any other kind, and the
dispatch below has no branch that reads a `SourceDocument.storage_key`. The
original PDF is unreachable from here no matter what a caller sends.

LIVE AND HISTORICAL ARE DIFFERENT KINDS, NOT THE SAME KIND WITH A FLAG. A
`clip` token names the live `question_clips` row; a `dclip` token names an
`attempt_question_snapshots` row and reads the key frozen inside it. Keeping
them apart is what stops a coach's replacement from rewriting what a finished
attempt is able to show.

EVERY FAILURE IS A 404
----------------------
Expired, tampered, wrong version, unknown id, missing object - all identical
from outside. A distinct "expired" or "bad signature" response would tell an
attacker which half of a forged token was closer to right.
"""

from flask import Blueprint, Response, abort, request

from app.errors import ApiError
from app.extensions import db
from app.models import AttemptQuestionSnapshot, DocumentPage, Question, QuestionClip
from app.services.page_masking import delivered_mask_bytes, masked_render_bytes
from app.services.private_storage import get_private_storage
from app.services.clip_storage import CLIP_CONTENT_TYPE, POSTER_CONTENT_TYPE
from app.services.signed_media import (
    KIND_CLIP,
    KIND_CLIP_POSTER,
    KIND_DELIVERED_CLIP,
    KIND_DELIVERED_CLIP_POSTER,
    KIND_DELIVERED_MASK,
    KIND_QUESTION_MASK,
    KIND_THUMBNAIL,
    InvalidMediaToken,
    seconds_until_expiry,
    verify_media_token,
)
from app.services.document_render import RENDER_CONTENT_TYPE

media_bp = Blueprint("media", __name__)


def _parse_range(raw: str, total: int):
    """One `Range: bytes=` header, resolved against a known total.

    Returns `(start, end)` inclusive, `None` when there is no usable range
    (serve the whole object), or the string "unsatisfiable" when the client
    asked for something outside the object and HTTP requires a 416.

    ONE RANGE ONLY. Multipart ranges are legal and no browser asks for them
    here, so supporting them would be untested code guarding a case that does
    not occur.
    """
    if not raw.startswith("bytes="):
        return None
    spec = raw[6:].split(",")[0].strip()
    first, sep, last = spec.partition("-")
    if not sep:
        return None
    try:
        if first:
            start = int(first)
            # `bytes=1000-` means "from here to the end".
            end = int(last) if last else total - 1
        elif last:
            # A suffix range - "the final N bytes".
            suffix = int(last)
            if suffix <= 0:
                return "unsatisfiable"
            start = max(0, total - suffix)
            end = total - 1
        else:
            return None
    except ValueError:
        # Nonsense rather than a boundary error. Falling back to the whole
        # object is what a client sending garbage should get.
        return None

    if start < 0 or start >= total:
        return "unsatisfiable"
    # A client may ask past the end; the spec says clamp rather than refuse.
    end = min(end, total - 1)
    if end < start:
        return "unsatisfiable"
    return start, end


def _serve_object(key: str, content_type: str, max_age: int, *, allow_ranges: bool):
    """Serves a stored object, fetching ONLY the bytes the client asked for.

    WHY THIS EXISTS. The previous implementation loaded the entire object from
    storage and then sliced it. iOS Safari opens a video with
    `Range: bytes=0-1`, so answering that probe meant downloading several
    megabytes from R2 to return two bytes - and then doing it again for the
    real request. Every player paid for both before the first frame appeared.

    Now the size comes from a HEAD and the body from a ranged GET, so a
    two-byte probe moves two bytes.

    `allow_ranges` is False for the small image kinds, which are always fetched
    whole and would only pay an extra HEAD for the privilege.
    """
    storage = get_private_storage()

    raw = request.headers.get("Range", "") if allow_ranges else ""
    if not raw:
        data = storage.load_private(key)
        if data is None:
            abort(404)
        return _whole_body(data, content_type, max_age, allow_ranges=allow_ranges)

    total = storage.private_size(key)
    if total is None:
        abort(404)
    if total == 0:
        # Nothing to range over; let the empty body answer honestly.
        return _whole_body(b"", content_type, max_age, allow_ranges=allow_ranges)

    resolved = _parse_range(raw, total)
    if resolved is None:
        data = storage.load_private(key)
        if data is None:
            abort(404)
        return _whole_body(data, content_type, max_age, allow_ranges=allow_ranges)

    if resolved == "unsatisfiable":
        # 416 with the total, so the client can correct itself rather than
        # guess. Returning the whole object here - which this used to do -
        # tells a confused client that its bad request was fine.
        response = Response(status=416, mimetype=content_type)
        response.headers["Content-Range"] = f"bytes */{total}"
        response.headers["Accept-Ranges"] = "bytes"
        return response

    start, end = resolved
    body = storage.load_private_range(key, start, end)
    if body is None:
        abort(404)

    response = Response(body, status=206, mimetype=content_type)
    response.headers["Accept-Ranges"] = "bytes"
    response.headers["Content-Length"] = str(len(body))
    response.headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    response.headers["Cache-Control"] = f"private, max-age={max_age}"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def _whole_body(data: bytes, content_type: str, max_age: int, *, allow_ranges: bool):
    response = Response(data, mimetype=content_type)
    if allow_ranges:
        # Advertised so a player's browser knows it may seek at all.
        response.headers["Accept-Ranges"] = "bytes"
    response.headers["Content-Length"] = str(len(data))
    response.headers["Cache-Control"] = f"private, max-age={max_age}"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def _masked_question_bytes(question_id: int) -> bytes | None:
    """This question's page with its regions masked, rendering on first request.

    A player can be the one to trigger that first render - the coach may never
    have previewed the question. The render is cached on the region, so only
    the first player of a given question ever waits.
    """
    question = db.session.get(Question, question_id)
    if question is None or not question.regions:
        return None
    try:
        return masked_render_bytes(question.regions[0])
    except ApiError:
        # The source document was deleted out from under a live quiz. A 404 is
        # the honest answer, and matches every other failure here.
        return None


def _delivered_clip_object(snapshot_id: int, *, poster: bool) -> tuple[str | None, str]:
    """The clip ONE ATTEMPT WAS DELIVERED, read from that attempt's snapshot.

    Resolves through the frozen `storage_key`, never through the live
    `question_clips` row - which is the entire point. Replacing a clip deletes
    that row, so anything resolving by row id returned 404 for every past
    attempt while the bytes sat untouched in storage.

    The snapshot's own `content_type` travels with it too: a historical object
    must be served as what it WAS, not as whatever the current clip happens to
    be encoded as.

    Returns the KEY rather than the bytes, so the caller can ask storage for
    only the range the player actually requested - see `_serve_object`.

    Fails closed at every step. A missing row, a snapshot recorded before clips
    existed and a malformed blob are all None, and the caller turns every one
    of them into the same 404.
    """
    row = db.session.get(AttemptQuestionSnapshot, snapshot_id)
    if row is None:
        return None, POSTER_CONTENT_TYPE
    blob = row.snapshot if isinstance(row.snapshot, dict) else {}
    clip = blob.get("clip")
    if not isinstance(clip, dict):
        # No clip key at all is an attempt delivered before this feature, or
        # one delivered without a clip. Neither is a licence to serve today's.
        return None, POSTER_CONTENT_TYPE
    if poster:
        key, content_type = clip.get("poster_key"), POSTER_CONTENT_TYPE
    else:
        key, content_type = clip.get("storage_key"), clip.get("content_type")
    if not key or not isinstance(key, str):
        return None, POSTER_CONTENT_TYPE
    if not isinstance(content_type, str) or not content_type:
        content_type = CLIP_CONTENT_TYPE
    return key, content_type


def _delivered_mask_bytes(snapshot_id: int) -> bytes | None:
    """The mask one attempt was delivered, from its frozen geometry.

    Serves the SNAPSHOT, never the live region - that is the whole reason this
    kind exists. A missing row or a snapshot with no recorded geometry returns
    None and 404s, the same honest failure every other kind here gives.
    """
    row = db.session.get(AttemptQuestionSnapshot, snapshot_id)
    if row is None:
        return None
    try:
        return delivered_mask_bytes(row)
    except ApiError:
        return None


@media_bp.get("/<token>")
def serve_signed_media(token: str):
    try:
        payload = verify_media_token(token)
    except InvalidMediaToken:
        abort(404)

    kind = payload["k"]

    content_type = RENDER_CONTENT_TYPE
    max_age = seconds_until_expiry(payload)

    # THE OBJECT IS RESOLVED TO A KEY, NEVER TO BYTES, for anything a player
    # might seek through. Loading first and slicing afterwards is what made a
    # two-byte probe cost a whole video - see `_serve_object`.
    #
    # AUTHORIZATION IS UNCHANGED AND STILL HAPPENS FIRST: the token was
    # verified above, and every branch below still resolves the key through
    # the same row lookups it always did. A ranged request gets no different
    # treatment from a whole one.
    if kind in (KIND_CLIP, KIND_CLIP_POSTER):
        clip = db.session.get(QuestionClip, payload["i"])
        if clip is None:
            abort(404)
        if kind == KIND_CLIP:
            key, content_type = clip.storage_key, clip.content_type
        else:
            key, content_type = clip.poster_key, POSTER_CONTENT_TYPE
        if not key:
            abort(404)
        return _serve_object(key, content_type, max_age, allow_ranges=kind == KIND_CLIP)

    if kind in (KIND_DELIVERED_CLIP, KIND_DELIVERED_CLIP_POSTER):
        key, content_type = _delivered_clip_object(
            payload["i"], poster=kind == KIND_DELIVERED_CLIP_POSTER
        )
        if not key:
            abort(404)
        return _serve_object(
            key, content_type, max_age, allow_ranges=kind == KIND_DELIVERED_CLIP
        )

    # The image kinds below are small, are always fetched whole, and some are
    # rendered on demand rather than stored - so they keep the simple path and
    # do not pay for a HEAD they would never use.
    if kind == KIND_DELIVERED_MASK:
        data = _delivered_mask_bytes(payload["i"])
    elif kind == KIND_QUESTION_MASK:
        data = _masked_question_bytes(payload["i"])
    else:
        page = db.session.get(DocumentPage, payload["i"])
        if page is None:
            abort(404)
        image_key = page.thumbnail_key if kind == KIND_THUMBNAIL else page.image_key
        if not image_key:
            abort(404)
        data = get_private_storage().load_private(image_key)

    if data is None:
        abort(404)

    # Cacheable, but never for longer than the token authorising it remains
    # valid - so a cached copy cannot outlive its authorisation. `private`
    # keeps it out of any shared/CDN cache. These bytes are only ever images,
    # and `nosniff` is belt and braces against a browser deciding otherwise
    # about content handed to it from a signed URL.
    return _whole_body(data, content_type, max_age, allow_ranges=False)
