"""Structural validation for an incoming DrawingDocument.

The document is authored entirely on the client and stored as one JSONB blob,
so this is the only point where the server can refuse a shape it cannot later
render. Without it a malformed envelope is accepted happily at save time and
fails at the moment a coach opens Results - which is the worst possible place
to discover it, because by then the player has gone home.

Deliberately structural, not semantic: it checks that the thing is a drawing
document of a version this server understands, not whether the strokes are a
sensible answer. Judging the answer is the coach's job.

Mirrors frontend/src/components/drawing/drawingDocument.ts::validateDocument.
The two must agree about what a valid document is; the client's copy exists to
refuse a corrupt local draft before rendering it, this one to refuse a corrupt
payload before storing it.
"""

from app.errors import ApiError

DRAWING_FORMAT = "peira.drawing"

#: Highest envelope version this server can store and hand back. A document
#: claiming a newer version came from a client deployed ahead of this backend
#: - possible for a few minutes mid-rollout, since Netlify and Render publish
#: independently - and is refused rather than stored in a shape the coach's
#: (older) viewer cannot read.
MAX_DOCUMENT_VERSION = 1

#: A dense two-minute drawing is a few tens of KB of JSON. A megabyte is not a
#: drawing; it is a runaway client or someone poking the endpoint. Refused with
#: a clear message rather than allowed to bloat the row and every later query
#: that loads it.
MAX_DOCUMENT_BYTES = 1_048_576


def validate_document(document: object) -> dict:
    """Returns the document, or raises ApiError(422) describing the problem."""
    if not isinstance(document, dict):
        raise ApiError("Drawing must be an object", status_code=422)

    if document.get("format") != DRAWING_FORMAT:
        raise ApiError("Unrecognised drawing format", status_code=422)

    version = document.get("version")
    if not isinstance(version, int):
        raise ApiError("Drawing is missing a version", status_code=422)
    if version > MAX_DOCUMENT_VERSION:
        raise ApiError(
            "This drawing was made by a newer version of the app. Reload and try again.",
            status_code=422,
        )

    for field in ("coordinate_width", "coordinate_height"):
        value = document.get(field)
        if not isinstance(value, (int, float)) or value <= 0:
            raise ApiError("Drawing is missing its coordinate space", status_code=422)

    source = document.get("source")
    if not isinstance(source, dict) or not source.get("image_id"):
        raise ApiError("Drawing is missing its source image reference", status_code=422)

    strokes = document.get("strokes")
    if not isinstance(strokes, list):
        raise ApiError("Drawing is missing its strokes", status_code=422)

    for index, stroke in enumerate(strokes):
        if not isinstance(stroke, dict):
            raise ApiError(f"Stroke {index} is malformed", status_code=422)
        points = stroke.get("points")
        # Flat [x0, y0, x1, y1, ...]: an odd length means a coordinate was
        # lost in transit, which would silently shift every later point in
        # that stroke.
        if not isinstance(points, list) or len(points) < 2 or len(points) % 2 != 0:
            raise ApiError(f"Stroke {index} has malformed points", status_code=422)

    return document


def assert_within_size_limit(raw_body_length: int | None) -> None:
    if raw_body_length is not None and raw_body_length > MAX_DOCUMENT_BYTES:
        raise ApiError("This drawing is too large to save", status_code=413)
