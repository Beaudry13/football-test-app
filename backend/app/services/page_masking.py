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
from app.models import QuestionRegion
from app.models.question_region import RegionRole
from app.services import document_render
from app.services.document_geometry import normalised_to_pixels
from app.services.private_storage import get_private_storage

#: Solid, opaque, and visibly deliberate - a player must read it as "something
#: has been hidden here", not as a printing defect. Near-black rather than pure
#: black so it reads as an applied mark on a white page.
MASK_FILL = (17, 20, 24)
#: A thin lighter edge, so a mask sitting against dark diagram ink is still
#: identifiable as a mask.
MASK_OUTLINE = (240, 240, 240)
MASK_OUTLINE_WIDTH = 2


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


def build_masked_render(region: QuestionRegion) -> bytes:
    """The page with this region's rectangle filled in."""
    page = region.document_page
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

    left, top, width, height = normalised_to_pixels(
        region.x, region.y, region.width, region.height, image.width, image.height
    )
    draw = ImageDraw.Draw(image)
    draw.rectangle(
        [left, top, left + width - 1, top + height - 1],
        fill=MASK_FILL,
        outline=MASK_OUTLINE,
        width=MASK_OUTLINE_WIDTH,
    )

    buffer = io.BytesIO()
    image.save(buffer, format="WEBP", lossless=True, quality=90, method=4)
    return buffer.getvalue()


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
