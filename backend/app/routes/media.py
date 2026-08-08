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

from app.extensions import db
from app.models import DocumentPage
from app.services.private_storage import get_private_storage
from app.services.signed_media import (
    KIND_PAGE,
    KIND_THUMBNAIL,
    InvalidMediaToken,
    seconds_until_expiry,
    verify_media_token,
)
from app.services.document_render import RENDER_CONTENT_TYPE

media_bp = Blueprint("media", __name__)


@media_bp.get("/<token>")
def serve_signed_media(token: str):
    try:
        payload = verify_media_token(token)
    except InvalidMediaToken:
        abort(404)

    kind = payload["k"]
    page = db.session.get(DocumentPage, payload["i"])
    if page is None:
        abort(404)

    if kind == KIND_THUMBNAIL:
        key = page.thumbnail_key
    elif kind == KIND_PAGE:
        key = page.image_key
    else:  # pragma: no cover - verify_media_token already rejects these
        abort(404)

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
