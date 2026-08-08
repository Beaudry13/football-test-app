"""A rectangle on a document page that a question is built from.

COORDINATES ARE NORMALISED 0-1, NOT PIXELS. `x`, `y`, `width` and `height` are
fractions of the page, so the same region is correct against a 1275px render,
a 2550px retina re-render, and a print export. The full contract and the
reasoning - including why this deliberately differs from
`question_images.canvas_width` - is in services/document_geometry.py.

WHY THIS IS A TABLE RATHER THAN FOUR COLUMNS ON `questions`
Today a question has one rectangle and the UI enforces that. The roadmap has
hotspots, drag-and-drop ordering and multi-part questions, all of which are
several regions on one question. A separate table costs nothing now and makes
those additive rather than a migration. The schema therefore permits many; V1
allows exactly one, enforced in the route.
"""

from app.extensions import db


class RegionRole:
    """What a rectangle MEANS, which is not the same as the question's type.

    Without this the renderer would have to infer intent from the question
    type, and that inference breaks the first time a coach wants a *masked*
    multiple choice ("which coverage is hidden here?") - a reasonable question
    the combined-response roadmap makes likely. See design doc §5.
    """

    #: Hide what is underneath. The player never receives those pixels.
    MASK = "mask"
    #: Draw attention without hiding anything.
    FOCUS = "focus"
    #: The region IS the image - used by Draw Response, where the crop becomes
    #: the drawing's coordinate space.
    CROP = "crop"

    ALL = frozenset({MASK, FOCUS, CROP})


class QuestionRegion(db.Model):
    __tablename__ = "question_regions"

    id = db.Column(db.Integer, primary_key=True)
    question_id = db.Column(
        db.Integer,
        db.ForeignKey("questions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    document_page_id = db.Column(
        db.Integer,
        db.ForeignKey("document_pages.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )

    #: The extension point for polygons. Only 'rect' exists; a region is stored
    #: as a shape record rather than four bare numbers so adding one later
    #: changes no existing row.
    shape = db.Column(db.String(16), nullable=False, default="rect", server_default="rect")

    # Normalised 0-1. See the module docstring.
    x = db.Column(db.Float, nullable=False)
    y = db.Column(db.Float, nullable=False)
    width = db.Column(db.Float, nullable=False)
    height = db.Column(db.Float, nullable=False)

    role = db.Column(db.String(16), nullable=False, default=RegionRole.MASK)
    position = db.Column(db.Integer, nullable=False, default=0)

    # The cached masked render of this region's page, as an opaque private
    # storage key. Derived, never authoritative: it can be deleted at any time
    # and will be regenerated from the page raster on the next request.
    #
    # Cached PER REGION because V1 allows exactly one region per question, so
    # "this region's mask" and "this question's mask set" are the same thing.
    # When multi-region questions arrive this moves to a (page, mask-set-hash)
    # cache, as design doc §6 describes.
    masked_image_key = db.Column(db.String(512), nullable=True)

    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now())
    updated_at = db.Column(
        db.DateTime(timezone=True), server_default=db.func.now(), onupdate=db.func.now()
    )

    question = db.relationship("Question", back_populates="regions")
    document_page = db.relationship("DocumentPage")

    def to_dict(self) -> dict:
        page = self.document_page
        return {
            "id": self.id,
            "question_id": self.question_id,
            "document_page_id": self.document_page_id,
            "shape": self.shape,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
            "role": self.role,
            "position": self.position,
            # Enough for a client to lay the region out over a render of any
            # size, without a second request. Not a coordinate authority - see
            # the module docstring.
            "page_number": page.page_number if page else None,
            "source_document_id": page.source_document_id if page else None,
            "render_width": page.render_width if page else None,
            "render_height": page.render_height if page else None,
            # masked_image_key is deliberately absent: clients receive a
            # short-lived signed URL, never a durable storage key.
        }
