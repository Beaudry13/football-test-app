"""Detected text runs on a document page - what tap-to-select taps.

WHY THIS IS NOT OCR, AND WHY THAT MATTERS
This reads a data structure already inside the file. PDFium hands back every
text run with its bounding box; there is no model, no inference, no per-request
cost, and nothing to be wrong about. If the PDF says the word COVER 3 occupies
that box, it does.

The spike (docs/DESIGN-playbook-quiz.md §0b) measured three real playbooks:
zero pages without a text layer, zero fragmented, and text-box ink density of
42-51% on every page - the boxes sit precisely on the glyphs. So tapping a run
places a mask pixel-perfectly, which a hand-drawn rectangle never does.

DETECTION IS A PROVIDER
`detect_text_runs` is the V1 implementation of one idea: something that turns a
page into candidate spans. An OCR provider for scanned pages would be a second
implementation of the same shape, returning lower-confidence spans, and the
editor would not change. That seam is why OCR stays deferred rather than
blocking - and why the UI must work with ZERO runs, which is the acceptance
test that keeps scanned playbooks first-class instead of broken.
"""

from __future__ import annotations

from app.services.document_render import open_document

#: A run this short is almost always a stray glyph rather than something worth
#: masking. Kept low deliberately: the position labels on a formation diagram
#: are single characters - X, M, SS - and they are exactly what a coach wants
#: to quiz on, so nothing here may filter them out.
MIN_RUN_CHARS = 1

#: PDFium occasionally reports zero-area or hairline rects. They cannot be
#: tapped and would only add noise to nearest-run hit testing.
MIN_RUN_SIZE_PT = 0.5


def detect_text_runs(pdf_bytes: bytes, page_index: int) -> list[dict]:
    """Every tappable text run on the page, in NORMALISED 0-1 page coordinates.

    Normalised, not points and not pixels, because that is the coordinate
    space regions are stored in - a tap must produce the same rectangle the
    coach would have drawn, and it must stay correct if the page is ever
    re-rendered at another resolution. See services/document_geometry.py.

    ORIGIN FLIP: PDF user space has its origin at the BOTTOM-left and y
    increasing upward; every client coordinate here has it at the TOP-left.
    Getting that backwards puts every mask on the wrong end of the page, which
    is why the conversion lives here once rather than at each call site.
    """
    document = open_document(pdf_bytes)
    page = document[page_index]
    width_pt = float(page.get_width())
    height_pt = float(page.get_height())
    if width_pt <= 0 or height_pt <= 0:
        return []

    textpage = page.get_textpage()
    runs: list[dict] = []

    for index in range(textpage.count_rects()):
        left, bottom, right, top = textpage.get_rect(index)
        if (right - left) < MIN_RUN_SIZE_PT or (top - bottom) < MIN_RUN_SIZE_PT:
            continue

        text = textpage.get_text_bounded(left=left, bottom=bottom, right=right, top=top)
        # Newlines survive extraction when a "run" spans a wrapped line. They
        # would be shown back to the coach as the expected answer, so they are
        # collapsed here rather than in the editor.
        text = " ".join(text.split())
        if len(text) < MIN_RUN_CHARS:
            continue

        runs.append(
            {
                "text": text,
                "x": max(0.0, left / width_pt),
                # The flip: a run's TOP edge in PDF space is its distance from
                # the bottom, so the client-space y is measured from the top.
                "y": max(0.0, (height_pt - top) / height_pt),
                "width": min(1.0, (right - left) / width_pt),
                "height": min(1.0, (top - bottom) / height_pt),
            }
        )

    return runs
