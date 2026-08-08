"""Developer/support tool: why does tap-to-mask behave the way it does on THIS PDF?

Not production code and not imported by the app. It exists for the support
question that will otherwise be unanswerable: a coach reports that tapping
does not select anything on their playbook, and someone needs to find out
whether the file has a text layer, whether its boxes sit on the glyphs, and
whether its runs are big enough to hit.

    python tools/pdf_probe.py <file.pdf> [more.pdf ...]

WHAT IT MEASURES, AND WHY EACH ONE
----------------------------------
A PDF can contain text that is present but useless, and each way it fails
breaks a different part of the authoring flow:

  chars per run        one run per character means a tap selects one letter
  text-box ink density boxes that miss the glyphs mean taps land on nothing
  reading-order score  scrambled order means generated prompts are nonsense
  median run size      a 9px run cannot be hit by point-in-box at all
  crowding             tiny AND crowded means a tap radius grabs the wrong run

The last two were the decisive ones when this ran against real playbooks:
formation pages have an excellent text layer made almost entirely of
one-character position labels (X, M, SS) that are far too small to tap
directly but isolated enough for nearest-run hit testing. See
docs/DESIGN-playbook-quiz.md §0b.

RELATIONSHIP TO PRODUCTION CODE
-------------------------------
None, deliberately. When Milestone 3 needs per-page tool defaulting it should
grow its own measurement in app/services/, not import from here - production
must not depend on a support script, and this must stay free to change.
"""

from __future__ import annotations

import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import pypdfium2 as pdfium
import pypdfium2.raw as raw

# Rendering scale used for the ink-alignment check. Matches the 150 DPI the
# design proposes for stored page rasters (72pt/inch is the PDF unit).
RENDER_SCALE = 150 / 72

# A text run holding this few characters, on average, is fragmented - the
# exporter emitted per-character or per-glyph runs rather than words. Tapping
# such a run selects one letter, which is worse than drawing a rectangle.
MIN_CHARS_PER_RUN_FOR_TAP = 3.0

# Below this, too little of what the eye sees is selectable for tap-first to be
# the primary interaction.
MIN_TEXT_COVERAGE_FOR_TAP = 0.55

# The width, in CSS pixels, of the authoring canvas we assume the coach works
# on. Run geometry is meaningless in PDF points - a 6pt label is comfortable on
# a desktop and untappable on a phone - so every target-size figure below is
# reported in rendered pixels at this width.
AUTHORING_CANVAS_PX = 1000.0

# A run narrower than this is not a reliable mouse target; narrower than the
# touch figure, not a reliable finger target (44px is the usual floor).
MIN_MOUSE_TARGET_PX = 24.0
MIN_TOUCH_TARGET_PX = 44.0

# Two runs whose boxes come within this many pixels of each other are crowded:
# a tap with hit-tolerance could resolve to the wrong one.
CROWDING_GAP_PX = 12.0


@dataclass
class PageReport:
    number: int
    width: float
    height: float

    char_count: int = 0
    rect_count: int = 0
    text_objects: int = 0
    path_objects: int = 0
    image_objects: int = 0
    form_objects: int = 0

    chars_per_rect: float = 0.0
    degenerate_boxes: int = 0
    out_of_bounds_boxes: int = 0

    ink_fraction: float = 0.0
    ink_inside_text_boxes: float = 0.0
    box_ink_density: float = 0.0
    text_coverage: float = 0.0

    median_run_px: float = 0.0
    mouse_tappable_share: float = 0.0
    touch_tappable_share: float = 0.0
    crowded_share: float = 0.0

    reading_order_score: float = 0.0
    sample_lines: list[str] = field(default_factory=list)
    classification: str = "UNKNOWN"
    notes: list[str] = field(default_factory=list)


def _page_objects(page) -> Counter:
    counts: Counter = Counter()
    for obj in page.get_objects():
        counts[obj.type] += 1
    return counts


def _text_rects(textpage, page_w: float, page_h: float):
    """Text rectangles with their content. PDFium groups characters into rects
    roughly per line-segment, which is the closest thing the file gives us to
    'a tappable thing'."""
    rects = []
    for i in range(textpage.count_rects()):
        left, bottom, right, top = textpage.get_rect(i)
        text = textpage.get_text_bounded(left=left, bottom=bottom, right=right, top=top)
        rects.append(
            {
                "left": left,
                "bottom": bottom,
                "right": right,
                "top": top,
                "width": right - left,
                "height": top - bottom,
                "text": text,
            }
        )
    return rects


def _reading_order_score(rects) -> float:
    """Fraction of consecutive rect pairs that advance in natural reading order
    (down the page, or left-to-right on the same line).

    Context-sentence generation reads the line a masked term sits in. If the
    order is scrambled, the generated prompt is nonsense, so this is measured
    rather than assumed.
    """
    if len(rects) < 2:
        return 1.0
    ok = 0
    for a, b in zip(rects, rects[1:]):
        same_line = abs(a["top"] - b["top"]) < max(2.0, a["height"] * 0.5)
        if same_line:
            if b["left"] >= a["left"] - 1:
                ok += 1
        elif b["top"] <= a["top"] + 1:  # PDF origin is bottom-left: lower top = further down
            ok += 1
    return ok / (len(rects) - 1)


def _target_geometry(rects, page_width: float) -> tuple[float, float, float, float]:
    """How big the tappable things actually are once drawn, and how close
    together they sit.

    This is the metric that decides tap-vs-drag, and it is not the same
    question as "is the text layer good". A formation diagram has an excellent
    text layer made up almost entirely of one-character position labels - X, M,
    SS - each about 6pt wide. Those are precisely the things a coach wants to
    mask, and they are also far too small to hit by point-in-box.

    Crowding is reported alongside, because it decides whether a generous hit
    test is safe: isolated labels tolerate a large tap radius, dense prose does
    not.
    """
    boxes = [r for r in rects if r["text"].strip() and r["width"] > 0 and r["height"] > 0]
    if not boxes:
        return 0.0, 0.0, 0.0, 0.0

    px_per_pt = AUTHORING_CANVAS_PX / page_width
    widths = sorted(b["width"] * px_per_pt for b in boxes)
    median = widths[len(widths) // 2]
    mouse = sum(1 for w in widths if w >= MIN_MOUSE_TARGET_PX) / len(widths)
    touch = sum(1 for w in widths if w >= MIN_TOUCH_TARGET_PX) / len(widths)

    crowded = 0
    for i, a in enumerate(boxes):
        for j, b in enumerate(boxes):
            if i == j:
                continue
            gap_x = max(b["left"] - a["right"], a["left"] - b["right"], 0.0) * px_per_pt
            gap_y = max(b["bottom"] - a["top"], a["bottom"] - b["top"], 0.0) * px_per_pt
            if gap_x < CROWDING_GAP_PX and gap_y < CROWDING_GAP_PX:
                crowded += 1
                break
    return median, mouse, touch, crowded / len(boxes)


def _ink_analysis(page, rects) -> tuple[float, float, float]:
    """Renders the page and measures (a) how much of it is inked, and (b) how
    much of that ink falls inside a reported text box.

    This is the alignment check: if PDFium's text boxes are trustworthy, most
    ink on a text page sits inside one. If boxes are misplaced - a known
    PowerPoint-export failure - ink lands outside them and tap targets will
    miss what the coach is aiming at.
    """
    bitmap = page.render(scale=RENDER_SCALE, grayscale=True)
    pil = bitmap.to_pil()
    w, h = pil.size
    px = pil.load()

    # Downsample the scan for speed; a playbook page at 150 DPI is ~1.2M px and
    # this is a proportion, not a precise measurement.
    step = max(1, min(w, h) // 400)

    inked = 0
    inked_in_box = 0
    total = 0

    # Pre-convert text boxes from PDF points (origin bottom-left) into raster
    # pixels (origin top-left).
    boxes = []
    for r in rects:
        boxes.append(
            (
                r["left"] * RENDER_SCALE,
                (page.get_height() - r["top"]) * RENDER_SCALE,
                r["right"] * RENDER_SCALE,
                (page.get_height() - r["bottom"]) * RENDER_SCALE,
            )
        )

    for y in range(0, h, step):
        for x in range(0, w, step):
            total += 1
            if px[x, y] >= 200:  # near-white: treat as paper
                continue
            inked += 1
            for bx0, by0, bx1, by1 in boxes:
                if bx0 <= x <= bx1 and by0 <= y <= by1:
                    inked_in_box += 1
                    break

    ink_fraction = inked / total if total else 0.0
    inside = inked_in_box / inked if inked else 0.0

    # Ink density INSIDE the text boxes, which is the actual alignment test.
    #
    # The `inside` figure above is a proportion of the whole page, so a
    # formation diagram scores low simply because most of its ink is the
    # picture - that says nothing about whether the text boxes are correct.
    # Real playbooks exposed this: pages with clean 12-chars-per-rect text were
    # being called unusable because 45% of their ink was the diagram.
    #
    # A box sitting on real glyphs is partially inked (roughly 5-40% for type).
    # A box floating over blank paper is near zero. That distinguishes
    # "misplaced boxes" from "page is mostly graphics".
    densities = []
    for bx0, by0, bx1, by1 in boxes:
        bw, bh = bx1 - bx0, by1 - by0
        if bw < 2 or bh < 2:
            continue
        box_total = box_inked = 0
        for y in range(int(by0), min(int(by1) + 1, h), max(1, int(bh) // 12 or 1)):
            for x in range(int(bx0), min(int(bx1) + 1, w), max(1, int(bw) // 24 or 1)):
                if 0 <= x < w and 0 <= y < h:
                    box_total += 1
                    if px[x, y] < 200:
                        box_inked += 1
        if box_total:
            densities.append(box_inked / box_total)

    box_density = sum(densities) / len(densities) if densities else 0.0
    return ink_fraction, inside, box_density


def _classify(r: PageReport) -> tuple[str, list[str]]:
    notes: list[str] = []

    if r.char_count == 0:
        if r.image_objects and not r.path_objects:
            return "RASTER_IMAGE", ["No text layer; page is a scanned or flattened image."]
        if r.path_objects > 200:
            return "VECTOR_OUTLINE", [
                f"No text layer but {r.path_objects} vector paths - text was likely "
                "converted to outlines on export."
            ]
        return "NO_TEXT", ["No text layer and little vector content."]

    if r.chars_per_rect and r.chars_per_rect < MIN_CHARS_PER_RUN_FOR_TAP:
        notes.append(
            f"Text arrives in fragments (~{r.chars_per_rect:.1f} chars per rect) - "
            "runs must be merged before they are tappable."
        )
        classification = "FRAGMENTED_TEXT"
    else:
        classification = "CLEAN_TEXT"

    # A formation diagram is the defining playbook page, and PowerPoint draws it
    # as VECTORS, not as an embedded image. Keying "mixed" on image objects
    # alone missed every one of them - which is why this keys on the combined
    # graphic-object count instead.
    graphic_objects = r.image_objects + r.path_objects
    if graphic_objects >= 8 and r.ink_inside_text_boxes < 0.85:
        kind = []
        if r.image_objects:
            kind.append(f"{r.image_objects} image")
        if r.path_objects:
            kind.append(f"{r.path_objects} vector path")
        notes.append(
            f"{' and '.join(kind)} object(s) alongside text, and "
            f"{1 - r.ink_inside_text_boxes:.0%} of ink sits outside any text box - "
            "a diagram with labels. Tap works for the labels; the graphic itself "
            "needs drag."
        )
        if classification == "CLEAN_TEXT":
            classification = "MIXED"

    if r.rect_count and r.box_ink_density < 0.02:
        notes.append(
            f"Text boxes contain almost no ink ({r.box_ink_density:.1%} density) - "
            "boxes are misplaced relative to the glyphs. Tap targets would miss."
        )

    if r.median_run_px and r.median_run_px < MIN_MOUSE_TARGET_PX:
        if r.crowded_share < 0.4:
            notes.append(
                f"Runs are tiny (median {r.median_run_px:.0f}px on a "
                f"{AUTHORING_CANVAS_PX:.0f}px canvas) but isolated "
                f"({r.crowded_share:.0%} crowded) - tappable only with "
                "nearest-run hit testing, not point-in-box."
            )
        else:
            notes.append(
                f"Runs are tiny (median {r.median_run_px:.0f}px) AND crowded "
                f"({r.crowded_share:.0%}) - a generous tap radius would grab the "
                "wrong run. This page needs drag."
            )
    if r.rect_count and r.touch_tappable_share < 0.3:
        notes.append(
            f"Only {r.touch_tappable_share:.0%} of runs reach a "
            f"{MIN_TOUCH_TARGET_PX:.0f}px touch target - not authorable on a "
            "phone without zoom."
        )

    if r.degenerate_boxes:
        notes.append(f"{r.degenerate_boxes} zero-area text box(es).")
    if r.out_of_bounds_boxes:
        notes.append(f"{r.out_of_bounds_boxes} text box(es) outside the page bounds.")
    if r.reading_order_score < 0.8:
        notes.append(
            f"Reading order is unreliable ({r.reading_order_score:.0%} of runs advance "
            "naturally) - auto-generated context sentences would be scrambled."
        )

    return classification, notes


def probe_page(page, number: int) -> PageReport:
    w, h = page.get_size()
    report = PageReport(number=number, width=w, height=h)

    counts = _page_objects(page)
    report.text_objects = counts.get(raw.FPDF_PAGEOBJ_TEXT, 0)
    report.path_objects = counts.get(raw.FPDF_PAGEOBJ_PATH, 0)
    report.image_objects = counts.get(raw.FPDF_PAGEOBJ_IMAGE, 0)
    report.form_objects = counts.get(raw.FPDF_PAGEOBJ_FORM, 0)

    textpage = page.get_textpage()
    report.char_count = textpage.count_chars()
    report.rect_count = textpage.count_rects()

    rects = _text_rects(textpage, w, h)
    if report.rect_count:
        report.chars_per_rect = report.char_count / report.rect_count

    for r in rects:
        if r["width"] <= 0.5 or r["height"] <= 0.5:
            report.degenerate_boxes += 1
        if r["left"] < -1 or r["bottom"] < -1 or r["right"] > w + 1 or r["top"] > h + 1:
            report.out_of_bounds_boxes += 1

    (
        report.median_run_px,
        report.mouse_tappable_share,
        report.touch_tappable_share,
        report.crowded_share,
    ) = _target_geometry(rects, w)

    report.reading_order_score = _reading_order_score(rects)
    report.sample_lines = [r["text"].strip() for r in rects if r["text"].strip()][:6]

    report.ink_fraction, report.ink_inside_text_boxes, report.box_ink_density = _ink_analysis(
        page, rects
    )
    # "Text coverage" here means: of the ink on the page, how much is accounted
    # for by the text layer. That is the closest proxy available for "what
    # fraction of visible text is selectable".
    report.text_coverage = report.ink_inside_text_boxes

    report.classification, report.notes = _classify(report)
    return report


def probe_document(path: Path, max_pages: int | None = None) -> list[PageReport]:
    doc = pdfium.PdfDocument(str(path))
    total = len(doc)
    limit = total if max_pages is None else min(total, max_pages)
    reports = []
    for i in range(limit):
        reports.append(probe_page(doc[i], i + 1))
    return reports


def verdict(reports: list[PageReport]) -> tuple[str, list[str]]:
    """The decision this spike exists to inform.

    Judged on the quality of the text that exists - fragmentation and box
    alignment - NOT on how much of the page is text. A formation diagram is
    mostly picture by design; that determines the tap/drag mix, not whether
    tapping works.
    """
    if not reports:
        return "NO-GO", ["No pages analysed."]

    kinds = Counter(r.classification for r in reports)
    n = len(reports)

    # A page is tappable if it has text at all, that text is not fragmented,
    # and its boxes sit on real glyphs.
    def tappable(r: PageReport) -> bool:
        """Has text, boxes sit on the glyphs, and the runs can actually be hit -
        either because they are large enough, or because they are small but
        isolated enough that nearest-run hit testing is unambiguous."""
        if r.char_count == 0 or r.box_ink_density < 0.02:
            return False
        big_enough = r.median_run_px >= MIN_MOUSE_TARGET_PX
        small_but_isolated = r.crowded_share < 0.4
        return big_enough or small_but_isolated

    tap_pages = [r for r in reports if tappable(r)]
    tap_share = len(tap_pages) / n
    frag_pages = [r for r in reports if r.char_count and r.chars_per_rect < MIN_CHARS_PER_RUN_FOR_TAP]
    tiny_pages = [r for r in reports if r.median_run_px and r.median_run_px < MIN_MOUSE_TARGET_PX]
    phone_ok = sum(1 for r in reports if r.touch_tappable_share >= 0.3) / n
    no_text_pages = [r for r in reports if r.char_count == 0]

    mean_density = sum(r.box_ink_density for r in reports if r.rect_count) / max(
        1, len([r for r in reports if r.rect_count])
    )
    mean_order = sum(r.reading_order_score for r in reports) / n
    graphic_share = sum(1 for r in reports if r.classification == "MIXED") / n

    lines = [
        f"pages analysed: {n}",
        "classification: " + ", ".join(f"{k}={v}" for k, v in kinds.most_common()),
        f"tap-viable pages: {len(tap_pages)}/{n} ({tap_share:.0%})",
        f"fragmented pages: {len(frag_pages)}/{n}",
        f"pages with no text layer: {len(no_text_pages)}/{n}",
        f"mean text-box ink density: {mean_density:.1%}  (alignment)",
        f"pages with sub-{MIN_MOUSE_TARGET_PX:.0f}px median runs: "
        f"{len(tiny_pages)}/{n} (need nearest-run hit testing)",
        f"pages authorable on a phone: {phone_ok:.0%}",
        f"mean reading-order score: {mean_order:.0%}",
        f"pages that also need drag (diagrams): {graphic_share:.0%}",
    ]

    # The bar for CONDITIONAL is deliberately low. "Tap works on 40% of pages"
    # is not a weak result when the remaining pages are diagrams that were never
    # going to be tappable - they need drag regardless of how good the text
    # layer is. The earlier 0.7 bar conflated "tap does not work" with "this
    # page is a picture", and reported NO-GO for a file whose text layer was
    # flawless on every page.
    if tap_share >= 0.7 and mean_density >= 0.02:
        decision = "GO - tap-first"
        lines.append(
            "Text arrives in word-level runs with boxes on the glyphs. Tap-to-mask "
            "should be the primary interaction."
        )
    elif tap_share >= 0.4 and mean_density >= 0.02:
        decision = "CONDITIONAL - tap-first alongside drag"
        lines.append(
            "The text layer is sound, but a large share of pages are diagrams "
            "whose content is not text at all. Tap-first works for the labels; "
            "drag must ship in V1 as a co-equal tool, not a fallback."
        )
    elif tap_share + (len(frag_pages) / n) >= 0.4:
        decision = "CONDITIONAL - tap-first with run merging"
        lines.append(
            "Usable text exists but a meaningful share of pages emit short runs. "
            "Tap-first is viable only with adjacent-run merging; budget for it."
        )
    else:
        decision = "NO-GO - drag-first for V1"
        lines.append(
            "Too few pages carry usable text. Ship drag-to-mask and revisit tap "
            "when an OCR provider exists."
        )

    if n < 10:
        lines.append(
            f"NOTE: only {n} page(s) sampled. Every share above is coarse; read "
            "the per-page numbers, not this headline."
        )

    if mean_order < 0.8:
        lines.append(
            f"CAVEAT: reading order scores {mean_order:.0%}. Auto-generated "
            "fill-in-the-blank prompts from surrounding text would often be "
            "scrambled - treat generated prompts as drafts, or omit them."
        )
    if len(tiny_pages) / n >= 0.3:
        lines.append(
            f"{len(tiny_pages) / n:.0%} of pages have runs too small to hit by "
            "point-in-box. Tap-first is viable only with nearest-run hit testing "
            "and a tap radius."
        )
    if phone_ok < 0.5:
        lines.append(
            f"Only {phone_ok:.0%} of pages are authorable on a phone. Authoring is "
            "a desktop workflow; do not promise phone authoring in V1."
        )
    if graphic_share >= 0.3:
        lines.append(
            f"{graphic_share:.0%} of pages are diagram-heavy, so drag is not a rare "
            "fallback - it is a first-class second interaction."
        )
    return decision, lines


def render_report(path: Path, reports: list[PageReport]) -> str:
    out = [f"\n{'=' * 78}", f"FILE: {path.name}", f"{'=' * 78}"]
    for r in reports:
        out.append(
            f"\n  page {r.number}  {r.width:.0f}x{r.height:.0f}pt   [{r.classification}]"
        )
        out.append(
            f"    chars={r.char_count}  rects={r.rect_count}  chars/rect={r.chars_per_rect:.1f}"
        )
        out.append(
            f"    objects: text={r.text_objects} path={r.path_objects} "
            f"image={r.image_objects} form={r.form_objects}"
        )
        out.append(
            f"    ink={r.ink_fraction:.1%} of page   ink-in-boxes={r.ink_inside_text_boxes:.0%}"
            f"   box-density={r.box_ink_density:.1%}   reading-order={r.reading_order_score:.0%}"
        )
        out.append(
            f"    median run={r.median_run_px:.0f}px @{AUTHORING_CANVAS_PX:.0f}px canvas"
            f"   mouse-sized={r.mouse_tappable_share:.0%}"
            f"   touch-sized={r.touch_tappable_share:.0%}"
            f"   crowded={r.crowded_share:.0%}"
        )
        if r.sample_lines:
            out.append(f"    sample: {r.sample_lines[:3]}")
        for note in r.notes:
            out.append(f"    ! {note}")

    decision, lines = verdict(reports)
    out.append(f"\n  {'-' * 74}")
    out.append(f"  VERDICT: {decision}")
    for line in lines:
        out.append(f"    {line}")
    return "\n".join(out)


def main(argv: list[str]) -> int:
    if not argv or argv[0] in {"-h", "--help"}:
        print(__doc__)
        return 0

    for arg in argv:
        path = Path(arg)
        if not path.exists():
            print(f"missing: {path}")
            continue
        reports = probe_document(path, max_pages=25)
        print(render_report(path, reports))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
