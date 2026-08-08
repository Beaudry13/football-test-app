"""THE COORDINATE CONTRACT for document pages and regions.

Read this before touching anything that positions a region on a page.

------------------------------------------------------------------------------
THE RULE
------------------------------------------------------------------------------
A region's position is stored as **normalised floats in [0, 1]**, relative to
the page, and nothing else is ever authoritative.

    x = 0.25  ->  a quarter of the way across the page, at any resolution
    x = 300   ->  meaningless, and must never be stored

Pixels are a *rendering detail*. `document_pages.render_width/render_height`
describe the raster that happens to exist today; they do not define where
anything is.

------------------------------------------------------------------------------
WHY THIS DIFFERS FROM question_images.canvas_width
------------------------------------------------------------------------------
CLAUDE.md records that annotation coordinates are pinned to
`question_images.canvas_width` and that changing it would move every saved
shape. That rule is correct *there* and would be wrong here, for one specific
reason:

  - An annotation is authored against a raster that CAN NEVER BE REGENERATED.
    The upload is recompressed on the way in and the original is gone, so the
    pixel grid the coach drew on is the only pixel grid there will ever be.
    Pinning to it is the only way to be safe.

  - A document page raster CAN ALWAYS BE REGENERATED, because the source PDF
    is kept privately and permanently. The pixel grid is disposable.

Pinning regions to a pixel grid would therefore forbid something otherwise
free - re-rendering a page at 300 DPI for a retina display or a print export -
without buying any safety that normalising does not already provide. Normalised
storage satisfies the underlying rule (a coordinate must never move under a
saved shape) more completely, not less: it is invariant under *every* future
render, not just under the one we happen to have.

See docs/DESIGN-playbook-quiz.md §4a.

------------------------------------------------------------------------------
THE ONE FORMULA
------------------------------------------------------------------------------
`page_pixel_size()` is the single definition of how a PDF page's point size
becomes a pixel size. It is called in two places that must never disagree:

  1. at upload, to pin `document_pages.render_width/height` for every page
     before anything is rendered, and
  2. in the renderer, to produce the actual bitmap.

If those two ever diverge, a region drawn against the stored dimensions lands
somewhere else on the real image. `document_render.render_page` asserts the
bitmap it produced matches, and a test renders a real PDF to prove it - a
mismatch is a hard failure rather than a rounding shrug.
"""

from __future__ import annotations

import math

#: PDF user-space is 72 points per inch, by definition of the format.
POINTS_PER_INCH = 72.0

#: Resolution for the canonical full-page raster. Enough to read 8pt playbook
#: type on screen and to embed in a PDF export; see design doc §8.
DEFAULT_RENDER_DPI = 150

#: Hard ceiling on the long edge of a rendered page. A 150 DPI letter page is
#: 1275x1650, comfortably inside this. The cap exists for the pathological
#: case - a poster-sized or maliciously huge MediaBox - where 150 DPI would
#: produce a bitmap large enough to exhaust memory. When it binds, the DPI is
#: reduced and the REDUCED value is what gets stored, so the page still
#: describes itself truthfully.
MAX_RENDER_EDGE_PX = 2200

#: Width of the page-strip thumbnails generated for every page at upload.
THUMBNAIL_WIDTH_PX = 220


def page_pixel_size(
    width_pt: float,
    height_pt: float,
    dpi: int = DEFAULT_RENDER_DPI,
    max_edge_px: int = MAX_RENDER_EDGE_PX,
) -> tuple[int, int, int]:
    """The canonical point-size -> pixel-size conversion.

    Returns `(width_px, height_px, effective_dpi)`. `effective_dpi` differs
    from `dpi` only when the cap binds, and is what callers must store.

    `math.ceil` rather than `round`: PDFium sizes its bitmap by rounding the
    scaled dimension *up*, so matching it here is what keeps the two
    definitions identical. This is the detail the whole contract turns on.

    DO NOT "FIX" THE FLOAT ARITHMETIC HERE. A US Letter page at 150 DPI comes
    out 1275x**1651**, not the 1650 the arithmetic obviously wants: 792 * (150/72)
    is 1650.0000000000002 in IEEE 754, and ceil takes it to 1651. Computing it
    as `792 * 150 / 72` would give a clean 1650 - and would be WRONG, because
    PDFium is handed the same `dpi / 72` float and makes a 1651-pixel bitmap.
    The contract is that this function agrees with the thing that actually
    produces the pixels, not with ideal arithmetic. `render_page` asserts the
    agreement and a test checks it across seven page geometries.
    """
    if width_pt <= 0 or height_pt <= 0:
        raise ValueError(f"Page has a non-positive size: {width_pt}x{height_pt}pt")

    scale = dpi / POINTS_PER_INCH
    width_px = math.ceil(width_pt * scale)
    height_px = math.ceil(height_pt * scale)

    longest = max(width_px, height_px)
    if longest > max_edge_px:
        # Reduce the DPI (not the pixel count directly) so the stored
        # render_dpi keeps describing the raster that actually exists.
        dpi = max(1, math.floor(dpi * max_edge_px / longest))
        scale = dpi / POINTS_PER_INCH
        width_px = math.ceil(width_pt * scale)
        height_px = math.ceil(height_pt * scale)

    return width_px, height_px, dpi


def thumbnail_pixel_size(
    width_pt: float, height_pt: float, target_width_px: int = THUMBNAIL_WIDTH_PX
) -> tuple[int, int, float]:
    """Thumbnail dimensions and the PDFium render scale that produces them.

    Thumbnails are decorative - nothing is ever positioned against one - so
    unlike `page_pixel_size` this does not need to be pinned anywhere.
    """
    if width_pt <= 0 or height_pt <= 0:
        raise ValueError(f"Page has a non-positive size: {width_pt}x{height_pt}pt")

    scale = target_width_px / width_pt
    return target_width_px, max(1, math.ceil(height_pt * scale)), scale


def render_scale_for(width_pt: float, dpi: int) -> float:
    """The scale factor to hand PDFium for a given DPI."""
    return dpi / POINTS_PER_INCH


# ---------------------------------------------------------------------------
# Normalised <-> pixel conversion.
#
# Used by masking and the editor from M2 onward. Defined here, with the rule
# they implement, so there is exactly one place that knows how a stored region
# becomes a rectangle on an image.
# ---------------------------------------------------------------------------


class NormalisedRectError(ValueError):
    """A rectangle that is not a valid normalised region."""


def validate_normalised_rect(x: float, y: float, width: float, height: float) -> None:
    """Rejects anything that is not a real region inside the page.

    Zero-area rectangles are rejected rather than clamped: a region with no
    area cannot be masked, cannot be tapped and cannot be cropped, so storing
    one only defers the failure to somewhere with less context.
    """
    for name, value in (("x", x), ("y", y), ("width", width), ("height", height)):
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise NormalisedRectError(f"{name} must be a number")
        if math.isnan(value) or math.isinf(value):
            raise NormalisedRectError(f"{name} must be finite")

    if width <= 0 or height <= 0:
        raise NormalisedRectError("A region must have a positive width and height")
    if x < 0 or y < 0:
        raise NormalisedRectError("A region must start inside the page")
    # Allow a hair over 1.0 so a region dragged flush to the right or bottom
    # edge is not rejected by float error in the client's division.
    if x + width > 1.000001 or y + height > 1.000001:
        raise NormalisedRectError("A region must not extend past the page edge")


def normalised_to_pixels(
    x: float, y: float, width: float, height: float, render_width: int, render_height: int
) -> tuple[int, int, int, int]:
    """A stored region -> a pixel rectangle on a raster of the given size.

    Rounds outward (floor the origin, ceil the far edge) so a mask always
    fully covers what it was drawn over. A mask one pixel short leaks a sliver
    of the answer, which is the whole thing masking exists to prevent; a mask
    one pixel long covers an extra pixel of blank paper and nobody notices.
    """
    validate_normalised_rect(x, y, width, height)

    left = math.floor(x * render_width)
    top = math.floor(y * render_height)
    right = math.ceil((x + width) * render_width)
    bottom = math.ceil((y + height) * render_height)

    left = max(0, min(left, render_width))
    top = max(0, min(top, render_height))
    right = max(left, min(right, render_width))
    bottom = max(top, min(bottom, render_height))

    return left, top, right - left, bottom - top


def pixels_to_normalised(
    left: float, top: float, width: float, height: float, render_width: int, render_height: int
) -> tuple[float, float, float, float]:
    """A pixel rectangle -> a storable region. The inverse of the above,
    within the rounding the outward-rounding rule deliberately introduces."""
    if render_width <= 0 or render_height <= 0:
        raise NormalisedRectError("Render dimensions must be positive")

    return (
        left / render_width,
        top / render_height,
        width / render_width,
        height / render_height,
    )
