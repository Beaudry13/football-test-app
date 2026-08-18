"""Signed-URL delivery of protected renders.

No JWT. The token IS the credential - which is not a weakening, but the only
mechanism that works: a player has no account, and a browser cannot attach an
Authorization header to an `<img src>` regardless. See
services/signed_media.py for the token design and why it carries a version
prefix from day one.

WHAT THIS ENDPOINT CAN REACH
----------------------------
Page rasters and thumbnails. That is the complete list, and it is enforced by
construction: `sign_media_token` refuses to mint any other kind, and the
dispatch below has no branch that reads a `SourceDocument.storage_key`. The
original PDF is unreachable from here no matter what a caller sends.

EVERY FAILURE IS A 404
----------------------
Expired, tampered, wrong version, unknown id, missing object - all identical
from outside. A distinct "expired" or "bad signature" response would tell an
attacker which half of a forged token was closer to right.
"""

from flask import Blueprint, Response, abort

from app.errors import ApiError
from app.extensions import db
from app.models import AttemptQuestionSnapshot, DocumentPage, Question
from app.services.page_masking import delivered_mask_bytes, masked_render_bytes
from app.services.private_storage import get_private_storage
from app.services.signed_media import (
    KIND_DELIVERED_MASK,
    KIND_QUESTION_MASK,
    KIND_THUMBNAIL,
    InvalidMediaToken,
    seconds_until_expiry,
    verify_media_token,
)
from app.services.document_render import RENDER_CONTENT_TYPE

media_bp = Blueprint("media", __name__)


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

    if kind == KIND_DELIVERED_MASK:
        data = _delivered_mask_bytes(payload["i"])
    elif kind == KIND_QUESTION_MASK:
        data = _masked_question_bytes(payload["i"])
    else:
        page = db.session.get(DocumentPage, payload["i"])
        if page is None:
            abort(404)
        key = page.thumbnail_key if kind == KIND_THUMBNAIL else page.image_key
        if not key:
            abort(404)
        data = get_private_storage().load_private(key)

    if data is None:
        abort(404)

    response = Response(data, mimetype=RENDER_CONTENT_TYPE)
    # Cacheable, but never for longer than the token authorising it remains
    # valid - so a cached copy cannot outlive its authorisation. `private`
    # keeps it out of any shared/CDN cache.
    response.headers["Cache-Control"] = f"private, max-age={seconds_until_expiry(payload)}"
    # These bytes are only ever images. Belt and braces against a browser
    # deciding otherwise about content it was handed from a signed URL.
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response
