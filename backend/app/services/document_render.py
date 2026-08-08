"""Server-side PDF inspection and rasterisation. The ONE rendering pipeline.

There is deliberately no second renderer. The editor does not run pdf.js and
the player does not receive a PDF - both look at a raster this module produced,
so there is exactly one coordinate space and no possibility of the coach having
masked something the player sees a few pixels away from. See design doc §3.

pypdfium2 (Apache-2.0/BSD) rather than PyMuPDF (AGPL) - the licence is a real
hazard for a hosted product, and PDFium does the job for free.

VALIDATION POSTURE
------------------
A PDF upload is untrusted input from the internet, so everything here assumes
the file is hostile until proved otherwise:

  - identified by MAGIC BYTES, not by the filename and not by the
    client-supplied Content-Type, either of which the client chooses
  - encrypted and malformed files are turned into clean 422s rather than
    500s, because a coach who picked the wrong file deserves to be told so
  - the page count is checked BEFORE a single page is rendered, so a
    decompression bomb is refused rather than rendered
"""

from __future__ import annotations

import hashlib
import io

import pypdfium2 as pdfium
from PIL import Image

from app.errors import ApiError
from app.services.document_geometry import (
    DEFAULT_RENDER_DPI,
    page_pixel_size,
    render_scale_for,
    thumbnail_pixel_size,
)

#: Every PDF begins with this. The extension and the Content-Type are both
#: chosen by the client and prove nothing.
PDF_MAGIC = b"%PDF-"

#: WebP, not PNG or JPEG. Playbook pages are line art and small type: WebP
#: lossless is substantially smaller than PNG on that content, and JPEG is
#: simply wrong for it (ringing artefacts around text). See design doc §8.
RENDER_CONTENT_TYPE = "image/webp"
RENDER_EXTENSION = "webp"


def renderer_version() -> str:
    """Provenance string stored on every page, so a raster produced by a
    different renderer build is identifiable after the fact."""
    try:
        import importlib.metadata as metadata

        lib = metadata.version("pypdfium2")
    except Exception:
        lib = "unknown"
    pdfium_version = getattr(pdfium, "PDFIUM_INFO", None)
    return f"pypdfium2/{lib} pdfium/{getattr(pdfium_version, 'version', 'unknown')}"[:64]


def content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def looks_like_pdf(data: bytes) -> bool:
    return data[:5] == PDF_MAGIC


def open_document(data: bytes) -> pdfium.PdfDocument:
    """Opens an untrusted PDF, or raises a client-facing ApiError.

    pypdfium2 raises PdfiumError for both "this is not a PDF I can parse" and
    "this needs a password". They are separated here because they are
    completely different problems from the coach's point of view: one means
    the file is broken, the other means they need to remove the password.
    """
    if not looks_like_pdf(data):
        raise ApiError(
            "That file isn't a PDF. Upload the playbook as a PDF and try again.",
            status_code=422,
        )

    try:
        document = pdfium.PdfDocument(io.BytesIO(data))
        # Page count is the first thing that actually parses structure, so a
        # truncated or corrupt file usually fails here rather than at open().
        len(document)
    except pdfium.PdfiumError as exc:
        message = str(exc).lower()
        if "password" in message or "encrypt" in message:
            raise ApiError(
                "That PDF is password-protected. Remove the password and upload it again.",
                status_code=422,
            ) from exc
        raise ApiError(
            "That PDF couldn't be read. It may be damaged or incomplete.",
            status_code=422,
        ) from exc

    return document


def page_sizes(document: pdfium.PdfDocument) -> list[tuple[float, float]]:
    """Every page's size in PDF points, without rendering anything.

    Cheap enough to run over a 400-page document on the upload request, which
    is what lets every page row be created - with its dimensions already
    pinned - before any pixels exist.
    """
    sizes = []
    for index in range(len(document)):
        page = document[index]
        sizes.append((float(page.get_width()), float(page.get_height())))
    return sizes


def _encode_webp(image: Image.Image, lossless: bool) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="WEBP", lossless=lossless, quality=90, method=4)
    return buffer.getvalue()


def render_page(
    document: pdfium.PdfDocument,
    page_index: int,
    *,
    expected_width: int,
    expected_height: int,
    dpi: int = DEFAULT_RENDER_DPI,
) -> bytes:
    """The canonical full-page raster.

    `expected_width/height` are the dimensions already stored on the page row
    at upload time. They are passed in and asserted rather than recomputed,
    because a silent disagreement between the size a region was positioned
    against and the size of the image it is drawn on is exactly the bug the
    coordinate contract exists to make impossible. If this ever fires it is a
    defect in page_pixel_size(), not a rounding difference to paper over.
    """
    page = document[page_index]
    bitmap = page.render(scale=render_scale_for(page.get_width(), dpi))
    image = bitmap.to_pil().convert("RGB")

    if (image.width, image.height) != (expected_width, expected_height):
        raise RuntimeError(
            "Rendered page does not match its pinned coordinate space: "
            f"rendered {image.width}x{image.height}, expected "
            f"{expected_width}x{expected_height}. page_pixel_size() and PDFium "
            "have diverged - see services/document_geometry.py."
        )

    return _encode_webp(image, lossless=True)


def render_thumbnail(document: pdfium.PdfDocument, page_index: int) -> bytes:
    """A page-strip thumbnail. Lossy: nothing is ever positioned against one,
    and 200 of them ride on a single upload response."""
    page = document[page_index]
    _, _, scale = thumbnail_pixel_size(page.get_width(), page.get_height())
    image = page.render(scale=scale).to_pil().convert("RGB")
    return _encode_webp(image, lossless=False)


def pin_page_dimensions(
    width_pt: float, height_pt: float, dpi: int = DEFAULT_RENDER_DPI
) -> tuple[int, int, int]:
    """The dimensions to store for a page. A thin, named wrapper over
    page_pixel_size so the call site reads as what it is: pinning a coordinate
    space that must never move again."""
    return page_pixel_size(width_pt, height_pt, dpi)
