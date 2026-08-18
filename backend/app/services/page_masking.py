"""Rendering a page with its masked regions filled in, server-side.

WHY THIS EXISTS AT ALL
If the player's browser received the full page and a black box were drawn over
it in CSS, every answer in the quiz would be one right-click away - or one
"disable CSS", or one DevTools inspection. For a graded assessment that is not
a rough edge, it is the quiz not working. So the pixels under a mask are never
sent: they are removed before delivery, here, on the server.

DERIVED, NOT DUPLICATED
The stored page raster stays single and unmasked. A masked view is generated
from it and cached on the region row, so N questions on one page produce at
most N cached renders from ONE stored page - which is exactly the "one page,
many questions" property the feature was asked for. The cache can be deleted
at any time; it regenerates on the next request.

See docs/DESIGN-playbook-quiz.md §6.
"""

from __future__ import annotations

import io

from PIL import Image, ImageDraw

from app.errors import ApiError
from app.extensions import db
from app.models import DocumentPage, QuestionRegion
from app.models.question_region import RegionRole
from app.services import document_render
from app.services.document_geometry import normalised_to_pixels
from app.services.private_storage import get_private_storage
from app.services.signed_media import KIND_QUESTION_MASK, sign_media_token

#: Solid, opaque, and visibly deliberate - a player must read it as "something
#: has been hidden here", not as a printing defect. Near-black rather than pure
#: black so it reads as an applied mark on a white page.
MASK_FILL = (17, 20, 24)
#: A thin lighter edge, so a mask sitting against dark diagram ink is still
#: identifiable as a mask.
MASK_OUTLINE = (240, 240, 240)
MASK_OUTLINE_WIDTH = 2


def attach_masked_media(quiz_payload: dict, *, audience: str) -> None:
    """Give every region-backed question in `quiz_payload` a signed URL to its
    MASKED page.

    THE ONE PLACE THAT DECIDES WHAT A REGION QUESTION'S PICTURE IS. A region
    question has no `question_images` row, so this URL is the only picture it
    has; a caller that forgets to attach it renders a question with nothing to
    look at. That is exactly what happened to Preview, which built its screen
    from the coach payload and showed an empty card for every playbook
    question while the real player flow was fine.

    THE URL IS SAFE TO ISSUE TO EITHER AUDIENCE, and that is the property that
    lets one function serve both. It resolves to the MASKED render - the same
    pixels a player receives, with the answer already removed from them. There
    is deliberately no token kind that resolves to the unmasked page or the
    source PDF, so this cannot be widened into a leak by passing a different
    argument.

    `audience` is still recorded per caller: `ac:<id>` for a player, `coach`
    for a coach. Nothing enforces it today - it is what a future revocation
    check keys on, and it keeps a leaked URL traceable to why it was issued.

    Mutates in place, and only for questions that HAVE a region. An ordinary
    uploaded-image question is untouched and keeps rendering from
    `image.image_url`.
    """
    for question in quiz_payload.get("questions", []):
        if not question.get("region"):
            continue
        token = sign_media_token(
            KIND_QUESTION_MASK, question["id"], audience=audience
        )
        question["masked_image_url"] = f"/api/media/{token}"


def ensure_page_raster(page) -> bytes:
    """The page's full-resolution raster, rendering and storing it if this is
    the first time anyone has needed it.

    Shared with the coach's page view: a page opened in the editor is already
    rendered by the time a player meets it, and vice versa.
    """
    storage = get_private_storage()
    if page.image_key:
        existing = storage.load_private(page.image_key)
        if existing is not None:
            return existing
        # The key points at nothing - a partially-completed delete, or storage
        # reconfigured underneath us. Re-render rather than serving a broken
        # image; the raster is reproducible from the PDF, which is the whole
        # reason the PDF is kept.
        page.image_key = None

    source = page.source_document
    pdf_bytes = storage.load_private(source.storage_key)
    if pdf_bytes is None:
        raise ApiError(
            "The source file for this document is no longer available.", status_code=410
        )

    document = document_render.open_document(pdf_bytes)
    raster = document_render.render_page(
        document,
        page.page_number - 1,
        expected_width=page.render_width,
        expected_height=page.render_height,
        dpi=page.render_dpi,
    )
    page.image_key = storage.save_private(
        raster,
        content_type=document_render.RENDER_CONTENT_TYPE,
        extension=document_render.RENDER_EXTENSION,
    )
    db.session.commit()
    return raster


def render_mask(page, x: float, y: float, width: float, height: float) -> bytes:
    """A page with ONE rectangle filled in, from normalised coordinates.

    PURE WITH RESPECT TO THE DATABASE: it takes numbers, not a region row. That
    is what lets the same renderer serve a LIVE rectangle and a rectangle
    FROZEN into a delivered snapshot, so the two can never drift into producing
    different pictures from the same geometry - which is the entire basis of
    the byte-identity guarantee.
    """
    raster = ensure_page_raster(page)

    image = Image.open(io.BytesIO(raster)).convert("RGB")
    # The stored dimensions are the ones the region was authored against. If
    # the raster ever disagreed, the mask would land somewhere other than the
    # coach drew it - so this is checked rather than assumed.
    if (image.width, image.height) != (page.render_width, page.render_height):
        raise RuntimeError(
            f"Page {page.id} raster is {image.width}x{image.height} but the page "
            f"records {page.render_width}x{page.render_height}. A mask drawn "
            "against the recorded size would be misplaced."
        )

    left, top, box_width, box_height = normalised_to_pixels(
        x, y, width, height, image.width, image.height
    )
    draw = ImageDraw.Draw(image)
    draw.rectangle(
        [left, top, left + box_width - 1, top + box_height - 1],
        fill=MASK_FILL,
        outline=MASK_OUTLINE,
        width=MASK_OUTLINE_WIDTH,
    )

    buffer = io.BytesIO()
    image.save(buffer, format="WEBP", lossless=True, quality=90, method=4)
    return buffer.getvalue()


def build_masked_render(region: QuestionRegion) -> bytes:
    """The page with this region's LIVE rectangle filled in."""
    return render_mask(
        region.document_page, region.x, region.y, region.width, region.height
    )


def delivered_mask_bytes(snapshot_row) -> bytes | None:
    """The mask THIS ATTEMPT was delivered, regenerated from frozen geometry.

    THE HISTORICAL READER. `masked_render_bytes` below answers "what does this
    question look like now"; this answers "what did this attempt receive", and
    the two stop agreeing the moment a coach moves the rectangle.

    Returns None when the snapshot records no geometry - a delivery captured
    before this was recorded, or a question that never had a region. The caller
    falls back to the live region, which is honest for a legacy attempt and is
    the only thing that could be said about it.

    THE CACHE FAST PATH IS AN OPTIMISATION, NOT A SECOND SOURCE OF TRUTH. When
    the live rectangle still equals the delivered one - overwhelmingly the
    common case, since most regions are never edited - the region's existing
    cached render is byte-identical by construction, so it is served rather
    than re-rendered. When they differ, this renders from the frozen numbers.
    Nothing new is stored either way.
    """
    frozen = (snapshot_row.snapshot or {}).get("region")
    if not frozen:
        return None

    page = db.session.get(DocumentPage, frozen.get("document_page_id"))
    if page is None:
        # The page is protected by ON DELETE RESTRICT while any region
        # references it, so this is not reachable today. Returning None rather
        # than raising keeps a missing page a 404 for one picture instead of a
        # 500 for the whole attempt.
        return None

    # A FOCUS or CROP region hides nothing, so the delivered picture is the
    # plain page - the same rule masked_render_bytes applies to a live region.
    if frozen.get("role") != RegionRole.MASK:
        return ensure_page_raster(page)

    live = (
        QuestionRegion.query.filter_by(question_id=snapshot_row.question_id)
        .order_by(QuestionRegion.position)
        .first()
    )
    if (
        live is not None
        and live.masked_image_key
        and live.document_page_id == frozen.get("document_page_id")
        and (live.x, live.y, live.width, live.height)
        == (frozen.get("x"), frozen.get("y"), frozen.get("width"), frozen.get("height"))
    ):
        cached = get_private_storage().load_private(live.masked_image_key)
        if cached is not None:
            return cached

    return render_mask(
        page, frozen["x"], frozen["y"], frozen["width"], frozen["height"]
    )


def masked_render_bytes(region: QuestionRegion) -> bytes:
    """This region's masked page, from cache or freshly built.

    A FOCUS or CROP region has nothing hidden, so it returns the plain page -
    the role decides what the render means, rather than the question's type
    deciding it (design doc §5).
    """
    if region.role != RegionRole.MASK:
        return ensure_page_raster(region.document_page)

    storage = get_private_storage()
    if region.masked_image_key:
        cached = storage.load_private(region.masked_image_key)
        if cached is not None:
            return cached
        region.masked_image_key = None

    rendered = build_masked_render(region)
    region.masked_image_key = storage.save_private(
        rendered,
        content_type=document_render.RENDER_CONTENT_TYPE,
        extension=document_render.RENDER_EXTENSION,
    )
    db.session.commit()
    return rendered


def invalidate_masked_render(region: QuestionRegion) -> None:
    """Drop the cached mask, because the rectangle moved.

    Called whenever a region's geometry changes. Deleting the object rather
    than leaving it is what stops a resized mask from continuing to serve the
    old rectangle - which would show the player the answer.
    """
    key = region.masked_image_key
    region.masked_image_key = None
    if key:
        get_private_storage().delete_private(key)
