"""The coordinate contract.

Tested heavily on purpose: every region in the Playbook Quiz feature is stored
against the rules in app/services/document_geometry.py, and a mistake here
moves masks off the words they were drawn over - silently, and only visibly to
a player who then sees the answer.
"""

import io

import pypdfium2 as pdfium
import pytest
from reportlab.pdfgen import canvas as rl_canvas

from app.services.document_geometry import (
    DEFAULT_RENDER_DPI,
    MAX_RENDER_EDGE_PX,
    NormalisedRectError,
    normalised_to_pixels,
    page_pixel_size,
    pixels_to_normalised,
    render_scale_for,
    thumbnail_pixel_size,
    validate_normalised_rect,
)

#: Real page geometries: US Letter portrait and landscape, A4, tabloid spread,
#: square, legal landscape, and a deliberately awkward fractional size.
PAGE_GEOMETRIES = [
    (612.0, 792.0),
    (792.0, 612.0),
    (595.276, 841.89),
    (1224.0, 792.0),
    (360.0, 360.0),
    (1008.0, 612.0),
    (200.5, 300.25),
]


class TestPagePixelSize:
    def test_letter_at_150_dpi(self):
        # 1651, not 1650: see the float-arithmetic note in page_pixel_size.
        # This is asserted explicitly so that "correcting" it to 1650 fails
        # here rather than silently at render time.
        assert page_pixel_size(612, 792) == (1275, 1651, 150)

    def test_is_deterministic(self):
        assert page_pixel_size(612, 792) == page_pixel_size(612, 792)

    def test_landscape_is_the_transpose_of_portrait(self):
        w, h, _ = page_pixel_size(612, 792)
        w2, h2, _ = page_pixel_size(792, 612)
        assert (w2, h2) == (h, w)

    @pytest.mark.parametrize("width_pt,height_pt", PAGE_GEOMETRIES)
    def test_never_exceeds_the_edge_cap(self, width_pt, height_pt):
        width, height, _ = page_pixel_size(width_pt, height_pt)
        assert max(width, height) <= MAX_RENDER_EDGE_PX

    def test_oversized_page_reduces_dpi_rather_than_cropping(self):
        # A poster-sized page must still render whole, at a lower resolution.
        width, height, dpi = page_pixel_size(2400, 3600)
        assert dpi < DEFAULT_RENDER_DPI
        assert max(width, height) <= MAX_RENDER_EDGE_PX
        # Aspect ratio must survive the reduction, or the page is distorted.
        assert abs((width / height) - (2400 / 3600)) < 0.01

    def test_reduced_dpi_is_reported_not_hidden(self):
        # The stored dpi has to describe the raster that actually exists,
        # otherwise a later re-render at "the same" dpi produces a different
        # size and every region on the page shifts.
        width, height, dpi = page_pixel_size(2400, 3600)
        assert page_pixel_size(2400, 3600, dpi=dpi)[:2] == (width, height)

    @pytest.mark.parametrize("bad", [(0, 100), (100, 0), (-1, 100), (100, -1)])
    def test_rejects_non_positive_pages(self, bad):
        with pytest.raises(ValueError):
            page_pixel_size(*bad)


class TestFormulaMatchesPdfium:
    """The contract that matters: the formula and the renderer must agree.

    If these ever diverge, a region positioned against the stored dimensions
    lands somewhere else on the real image.
    """

    @staticmethod
    def _pdf_with(sizes):
        buffer = io.BytesIO()
        canvas = rl_canvas.Canvas(buffer)
        for width, height in sizes:
            canvas.setPageSize((width, height))
            canvas.drawString(10, 10, "x")
            canvas.showPage()
        canvas.save()
        buffer.seek(0)
        return buffer

    def test_every_geometry_renders_to_its_pinned_size(self):
        document = pdfium.PdfDocument(self._pdf_with(PAGE_GEOMETRIES))
        for index, (width_pt, height_pt) in enumerate(PAGE_GEOMETRIES):
            expected_w, expected_h, dpi = page_pixel_size(width_pt, height_pt)
            image = document[index].render(scale=render_scale_for(width_pt, dpi)).to_pil()
            assert (image.width, image.height) == (expected_w, expected_h), (
                f"{width_pt}x{height_pt}pt at {dpi}dpi: formula says "
                f"{expected_w}x{expected_h}, PDFium made {image.width}x{image.height}"
            )


class TestThumbnailPixelSize:
    def test_targets_the_requested_width(self):
        width, _, _ = thumbnail_pixel_size(612, 792, target_width_px=220)
        assert width == 220

    def test_preserves_aspect_ratio(self):
        width, height, _ = thumbnail_pixel_size(612, 792, target_width_px=220)
        assert abs((width / height) - (612 / 792)) < 0.01

    def test_height_is_never_zero_for_a_wide_thin_page(self):
        _, height, _ = thumbnail_pixel_size(2000, 5, target_width_px=220)
        assert height >= 1


class TestNormalisedRectValidation:
    def test_accepts_a_normal_region(self):
        validate_normalised_rect(0.1, 0.2, 0.3, 0.4)

    def test_accepts_a_region_flush_to_the_far_edge(self):
        validate_normalised_rect(0.0, 0.0, 1.0, 1.0)

    def test_tolerates_float_error_at_the_edge(self):
        # A client dividing pixels by page width can land a hair over 1.0.
        validate_normalised_rect(0.5, 0.5, 0.5000004, 0.5000004)

    @pytest.mark.parametrize(
        "rect",
        [
            (0.1, 0.1, 0.0, 0.5),  # zero width
            (0.1, 0.1, 0.5, 0.0),  # zero height
            (0.1, 0.1, -0.2, 0.5),  # negative width
            (-0.1, 0.1, 0.2, 0.5),  # starts off-page
            (0.1, -0.1, 0.2, 0.5),
            (0.8, 0.1, 0.5, 0.5),  # runs off the right edge
            (0.1, 0.8, 0.5, 0.5),  # runs off the bottom
        ],
    )
    def test_rejects_invalid_regions(self, rect):
        with pytest.raises(NormalisedRectError):
            validate_normalised_rect(*rect)

    @pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
    def test_rejects_non_finite_numbers(self, bad):
        with pytest.raises(NormalisedRectError):
            validate_normalised_rect(bad, 0.1, 0.2, 0.2)

    def test_rejects_booleans_masquerading_as_numbers(self):
        # bool is a subclass of int in Python, so True would otherwise pass
        # every numeric check and store a region at x=1.
        with pytest.raises(NormalisedRectError):
            validate_normalised_rect(True, 0.1, 0.2, 0.2)

    def test_rejects_strings(self):
        with pytest.raises(NormalisedRectError):
            validate_normalised_rect("0.1", 0.1, 0.2, 0.2)


class TestNormalisedToPixels:
    def test_converts_a_half_page_region(self):
        assert normalised_to_pixels(0.0, 0.0, 0.5, 0.5, 1000, 800) == (0, 0, 500, 400)

    def test_a_full_page_region_covers_the_whole_raster(self):
        assert normalised_to_pixels(0.0, 0.0, 1.0, 1.0, 1275, 1651) == (0, 0, 1275, 1651)

    def test_rounds_outward_so_a_mask_never_leaks(self):
        # The rule: a mask one pixel too large hides a pixel of blank paper.
        # A mask one pixel too small shows a sliver of the answer. Only one of
        # those is acceptable, so rounding always goes outward.
        left, top, width, height = normalised_to_pixels(0.101, 0.101, 0.1, 0.1, 1000, 1000)
        assert left <= 101 and top <= 101
        assert left + width >= 201
        assert top + height >= 201

    def test_never_exceeds_the_raster(self):
        left, top, width, height = normalised_to_pixels(0.0, 0.0, 1.0, 1.0, 37, 41)
        assert left + width <= 37
        assert top + height <= 41

    def test_the_same_region_scales_with_the_raster(self):
        # THE POINT OF NORMALISED STORAGE: one stored region, two resolutions,
        # the same place on the page. This is what pinned pixels would forbid.
        small = normalised_to_pixels(0.25, 0.25, 0.5, 0.5, 1000, 1000)
        large = normalised_to_pixels(0.25, 0.25, 0.5, 0.5, 2000, 2000)
        assert small == (250, 250, 500, 500)
        assert large == (500, 500, 1000, 1000)

    def test_rejects_an_invalid_region(self):
        with pytest.raises(NormalisedRectError):
            normalised_to_pixels(0.1, 0.1, 0.0, 0.5, 1000, 1000)


class TestPixelsToNormalised:
    def test_round_trips_within_a_pixel(self):
        original = (0.2, 0.3, 0.4, 0.25)
        left, top, width, height = normalised_to_pixels(*original, 1275, 1651)
        back = pixels_to_normalised(left, top, width, height, 1275, 1651)
        for produced, expected in zip(back, original):
            assert abs(produced - expected) < 0.002

    def test_a_region_derived_at_one_size_is_valid_at_another(self):
        # A coach drags on a 1275px-wide render; the same region must be
        # usable against a 2550px re-render without any conversion step.
        normalised = pixels_to_normalised(100, 200, 300, 400, 1275, 1651)
        validate_normalised_rect(*normalised)
        left, top, width, height = normalised_to_pixels(*normalised, 2550, 3302)
        assert abs(left - 200) <= 1
        assert abs(width - 600) <= 2

    def test_rejects_a_zero_sized_raster(self):
        with pytest.raises(NormalisedRectError):
            pixels_to_normalised(0, 0, 10, 10, 0, 100)
