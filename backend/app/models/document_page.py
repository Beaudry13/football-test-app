"""One page of a source document, and the raster it is displayed as."""

from app.extensions import db


class DocumentPage(db.Model):
    """A page. Immutable once created.

    Every page of a document gets a row at UPLOAD time, with its dimensions
    already pinned - not lazily on first open. That matters: it means the
    coordinate space for page 200 is fixed before anyone has looked at it, so
    it cannot depend on when, or whether, someone eventually does.

    Only the *pixels* are produced lazily. `thumbnail_key` is filled at upload
    (they are small and the page strip needs them immediately); `image_key`
    stays NULL until a coach actually opens the page, so a 200-page playbook
    where 8 pages get used stores 8 full renders rather than 200. See design
    doc §8.
    """

    __tablename__ = "document_pages"

    id = db.Column(db.Integer, primary_key=True)
    source_document_id = db.Column(
        db.Integer,
        db.ForeignKey("source_documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    #: 1-based, matching what the coach sees and what the PDF calls it.
    page_number = db.Column(db.Integer, nullable=False)

    # The page's size in PDF points - the real invariant. Everything else here
    # is derived from these two numbers, so a future re-render at any DPI
    # starts from the same place this one did.
    width_pt = db.Column(db.Float, nullable=False)
    height_pt = db.Column(db.Float, nullable=False)

    # The raster's dimensions. NOTE: these DESCRIBE the image; they do not
    # define where anything is. Regions are stored in normalised 0-1
    # coordinates and are invariant under a re-render at a different size.
    # services/document_geometry.py holds the contract and the reasoning.
    render_width = db.Column(db.Integer, nullable=False)
    render_height = db.Column(db.Integer, nullable=False)
    render_dpi = db.Column(db.Integer, nullable=False)
    #: e.g. "pypdfium2/5.12.1 pdfium/152.0.7947.0" - provenance, so a raster
    #: produced by a different renderer version is detectable after the fact.
    renderer_version = db.Column(db.String(64), nullable=False)

    # Opaque private-storage keys, never URLs. Reaching either one requires a
    # signed token issued by the API. See services/signed_media.py.
    image_key = db.Column(db.String(512), nullable=True)
    thumbnail_key = db.Column(db.String(512), nullable=True)

    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now())

    source_document = db.relationship("SourceDocument", back_populates="pages")

    __table_args__ = (
        db.UniqueConstraint("source_document_id", "page_number", name="uq_document_page_number"),
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "source_document_id": self.source_document_id,
            "page_number": self.page_number,
            "width_pt": self.width_pt,
            "height_pt": self.height_pt,
            "render_width": self.render_width,
            "render_height": self.render_height,
            "render_dpi": self.render_dpi,
            # Lets the editor reserve the right box before any image loads,
            # so the page strip does not reflow as thumbnails arrive.
            "aspect_ratio": (
                round(self.render_width / self.render_height, 6) if self.render_height else None
            ),
            # Whether the full raster has been produced yet. The editor uses
            # this to show a "rendering..." state on first open instead of a
            # broken image.
            "has_full_render": self.image_key is not None,
            # image_key / thumbnail_key are deliberately absent: a client
            # receives short-lived signed URLs, never a durable key.
        }
