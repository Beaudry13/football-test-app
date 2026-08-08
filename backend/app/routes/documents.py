"""Source-document upload, listing, page rendering and deletion.

Coach-only, JWT on every route. Tenancy is the organization, and a document
belonging to another organization is a 404 rather than a 403 - the existing
convention in utils/auth.py, so an id cannot be probed for existence.

NOTHING HERE EVER RETURNS THE PDF. There is no route that serves it, and
`SourceDocument.to_dict()` omits `storage_key`. The bytes are read exactly
once per request that needs them, server-side, and are never handed to a
client in any form. See docs/DESIGN-playbook-quiz.md §7a.
"""

from flask import Blueprint, current_app, jsonify, request
from flask_jwt_extended import jwt_required

from app.errors import ApiError
from app.extensions import db
from app.models import DocumentPage, SourceDocument
from app.schemas.document import DocumentUpdateSchema
from app.services import document_render
from app.services.private_storage import get_private_storage
from app.services.signed_media import KIND_PAGE, KIND_THUMBNAIL, sign_media_token
from app.utils.auth import current_coach
from app.utils.validation import load_json_body

documents_bp = Blueprint("documents", __name__)


def _get_org_document(document_id: int) -> SourceDocument:
    """A document in the caller's organization. Org-shared, like folders and
    groups: a playbook is team infrastructure, not one coach's private work."""
    coach = current_coach()
    document = db.session.get(SourceDocument, document_id)
    if document is None or document.organization_id != coach.organization_id:
        raise ApiError("Document not found", status_code=404)
    return document


def _page_payload(page: DocumentPage) -> dict:
    """A page plus freshly-signed URLs for whatever rasters exist.

    Signed here, at response time, rather than stored anywhere: a URL that
    lives for ten minutes is only useful if it is minted when it is about to
    be used.
    """
    data = page.to_dict()
    data["thumbnail_url"] = (
        f"/api/media/{sign_media_token(KIND_THUMBNAIL, page.id)}" if page.thumbnail_key else None
    )
    data["image_url"] = (
        f"/api/media/{sign_media_token(KIND_PAGE, page.id)}" if page.image_key else None
    )
    return data


@documents_bp.post("")
@jwt_required()
def upload_document():
    """Accept a PDF, store it privately, and create a pinned page row per page.

    Thumbnails for every page are generated synchronously here, because the
    page strip is useless without them and PDFium renders one in single-digit
    milliseconds. Full-resolution renders are NOT generated - see
    `get_page` - so a 200-page playbook costs 200 small thumbnails on upload
    rather than ~300 MB of rasters nobody asked for (design doc §8).
    """
    coach = current_coach()

    uploaded = request.files.get("file")
    if uploaded is None or not uploaded.filename:
        raise ApiError("No PDF file provided", status_code=400)

    data = uploaded.stream.read()
    if not data:
        raise ApiError("The uploaded file is empty", status_code=422)

    # Werkzeug's MAX_CONTENT_LENGTH is a coarse backstop covering every route;
    # this is the PDF-specific limit, checked against the bytes actually read
    # rather than a header the client controls.
    max_bytes = current_app.config["PDF_MAX_UPLOAD_BYTES"]
    if len(data) > max_bytes:
        raise ApiError(
            f"That PDF is too large. The limit is {max_bytes // (1024 * 1024)} MB.",
            status_code=413,
        )

    # Raises a clean 422 for a non-PDF, an encrypted PDF or a damaged one.
    document = document_render.open_document(data)

    page_count = len(document)
    if page_count == 0:
        raise ApiError("That PDF has no pages", status_code=422)

    max_pages = current_app.config["PDF_MAX_PAGES"]
    if page_count > max_pages:
        raise ApiError(
            f"That PDF has {page_count} pages, which is more than the {max_pages}-page "
            "limit. Split it into smaller documents and upload them separately.",
            status_code=422,
        )

    # Sizes first, for every page, before any rendering: this is what lets each
    # page's coordinate space be pinned up front rather than depending on when
    # someone happens to open it.
    sizes = document_render.page_sizes(document)

    storage = get_private_storage()
    pdf_key = storage.save_private(data, content_type="application/pdf", extension="pdf")

    # Keys written to storage but not yet committed to the database. If
    # anything below fails, these are orphaned bytes - so they are tracked and
    # cleaned up rather than silently left behind.
    written_keys = [pdf_key]

    try:
        source = SourceDocument(
            organization_id=coach.organization_id,
            uploaded_by_coach_id=coach.id,
            title=_default_title(uploaded.filename),
            original_filename=uploaded.filename[:255],
            storage_key=pdf_key,
            byte_size=len(data),
            page_count=page_count,
            content_hash=document_render.content_hash(data),
        )
        db.session.add(source)

        version = document_render.renderer_version()
        for index, (width_pt, height_pt) in enumerate(sizes):
            render_width, render_height, dpi = document_render.pin_page_dimensions(
                width_pt, height_pt
            )
            thumbnail = document_render.render_thumbnail(document, index)
            thumbnail_key = storage.save_private(
                thumbnail,
                content_type=document_render.RENDER_CONTENT_TYPE,
                extension=document_render.RENDER_EXTENSION,
            )
            written_keys.append(thumbnail_key)

            source.pages.append(
                DocumentPage(
                    page_number=index + 1,
                    width_pt=width_pt,
                    height_pt=height_pt,
                    render_width=render_width,
                    render_height=render_height,
                    render_dpi=dpi,
                    renderer_version=version,
                    thumbnail_key=thumbnail_key,
                )
            )

        db.session.commit()
    except Exception:
        db.session.rollback()
        for key in written_keys:
            storage.delete_private(key)
        raise

    return jsonify(_document_payload(source)), 201


def _default_title(filename: str) -> str:
    """The filename without its extension. Coaches name playbook files
    meaningfully ("CROWN.pdf"), so this is nearly always right, and it is
    editable afterwards."""
    stem = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if "." in stem:
        stem = stem.rsplit(".", 1)[0]
    return (stem.strip() or "Untitled document")[:255]


def _document_payload(source: SourceDocument) -> dict:
    data = source.to_dict()
    data["pages"] = [_page_payload(page) for page in source.pages]
    return data


@documents_bp.get("")
@jwt_required()
def list_documents():
    coach = current_coach()
    documents = (
        SourceDocument.query.filter_by(organization_id=coach.organization_id)
        .order_by(SourceDocument.created_at.desc())
        .all()
    )
    # Deliberately without pages: a listing needs titles and page counts, and
    # signing a token per page across every document in an organization would
    # be a lot of HMACs for a screen that shows none of them.
    return jsonify([document.to_dict() for document in documents])


@documents_bp.get("/<int:document_id>")
@jwt_required()
def get_document(document_id: int):
    source = _get_org_document(document_id)
    return jsonify(_document_payload(source))


@documents_bp.patch("/<int:document_id>")
@jwt_required()
def update_document(document_id: int):
    source = _get_org_document(document_id)
    payload = load_json_body(DocumentUpdateSchema())
    source.title = payload["title"]
    db.session.commit()
    return jsonify(source.to_dict())


@documents_bp.get("/<int:document_id>/pages/<int:page_number>")
@jwt_required()
def get_page(document_id: int, page_number: int):
    """A page, rendering it at full resolution on first request.

    This is the second tier of the three-tier strategy in design doc §8: the
    coach waits once, for a page they actually chose to open, and never again.
    `image_key` on the row IS the cache - there is no separate cache to
    invalidate or evict.
    """
    source = _get_org_document(document_id)
    page = DocumentPage.query.filter_by(
        source_document_id=source.id, page_number=page_number
    ).first()
    if page is None:
        raise ApiError("Page not found", status_code=404)

    if page.image_key is None:
        _render_full_page(source, page)

    return jsonify(_page_payload(page))


def _render_full_page(source: SourceDocument, page: DocumentPage) -> None:
    storage = get_private_storage()
    data = storage.load_private(source.storage_key)
    if data is None:
        # The row exists but its bytes do not - a storage misconfiguration or
        # a partially-completed delete. Say so plainly rather than serving a
        # broken image.
        raise ApiError(
            "The source file for this document is no longer available.", status_code=410
        )

    document = document_render.open_document(data)
    image = document_render.render_page(
        document,
        page.page_number - 1,
        expected_width=page.render_width,
        expected_height=page.render_height,
        dpi=page.render_dpi,
    )
    page.image_key = storage.save_private(
        image,
        content_type=document_render.RENDER_CONTENT_TYPE,
        extension=document_render.RENDER_EXTENSION,
    )
    db.session.commit()


@documents_bp.delete("/<int:document_id>")
@jwt_required()
def delete_document(document_id: int):
    """Remove a document and every private asset it owns.

    ORDERING: the database rows are committed first, then the objects are
    deleted best-effort. That way a failure part-way through leaves
    unreferenced bytes in the bucket - garbage, cleanable, harmless - rather
    than a row pointing at an object that no longer exists, which would
    surface to a coach as a permanently broken page.

    Keys are collected BEFORE the delete, because afterwards there is nothing
    left to read them from.
    """
    source = _get_org_document(document_id)

    keys = [source.storage_key]
    for page in source.pages:
        keys.extend(key for key in (page.image_key, page.thumbnail_key) if key)

    db.session.delete(source)
    db.session.commit()

    storage = get_private_storage()
    for key in keys:
        storage.delete_private(key)

    return "", 204
