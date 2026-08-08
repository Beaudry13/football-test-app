"""An uploaded source document (today: a playbook PDF) and its rendered pages.

NAMING: these tables say "document", not "playbook", deliberately. The
machinery - upload, render pages, position regions - is not about playbooks,
and will serve scouting reports, install sheets, call sheets and whiteboard
photos. "Playbook Quiz" is the product name the coach sees; the domain model
stays general so a scouting report never has to live in a table called
`playbooks`. See docs/DESIGN-playbook-quiz.md §1.
"""

from app.extensions import db


class SourceDocument(db.Model):
    """The uploaded file itself. Immutable once created.

    A re-upload of a revised playbook creates a NEW SourceDocument rather than
    mutating this one, so questions already written against the old pages keep
    rendering exactly as they were authored - and a completed quiz's results
    keep meaning what they meant. See design doc §9.
    """

    __tablename__ = "source_documents"

    id = db.Column(db.Integer, primary_key=True)

    # Tenancy is the ORGANIZATION, not the coach: a playbook must survive the
    # coach who uploaded it leaving the program, and assistants need to build
    # from it. Matches the folders/groups pattern in utils/auth.py.
    organization_id = db.Column(
        db.Integer, db.ForeignKey("organizations.id"), nullable=False, index=True
    )
    # SET NULL rather than CASCADE, for the same reason: losing a coach must
    # not take the team's playbook with them.
    uploaded_by_coach_id = db.Column(
        db.Integer, db.ForeignKey("coaches.id", ondelete="SET NULL"), nullable=True
    )

    title = db.Column(db.String(255), nullable=False)
    original_filename = db.Column(db.String(255), nullable=False)

    # An opaque key into private storage - NEVER a URL, and never rendered
    # into any API response. See services/private_storage.py.
    storage_key = db.Column(db.String(512), nullable=False)

    byte_size = db.Column(db.Integer, nullable=False)
    page_count = db.Column(db.Integer, nullable=False)

    # sha256 of the uploaded bytes. Indexed, not unique: the design calls for
    # *recognising* a byte-identical re-upload and offering to reuse it (§9),
    # which is a conversation with the coach, not a constraint that refuses
    # their upload. Storing it now keeps that option open for free.
    content_hash = db.Column(db.String(64), nullable=False, index=True)

    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now())

    organization = db.relationship("Organization")
    uploaded_by = db.relationship("Coach")
    pages = db.relationship(
        "DocumentPage",
        back_populates="source_document",
        cascade="all, delete-orphan",
        order_by="DocumentPage.page_number",
    )

    def to_dict(self, include_pages: bool = False) -> dict:
        data = {
            "id": self.id,
            "organization_id": self.organization_id,
            "uploaded_by_coach_id": self.uploaded_by_coach_id,
            "title": self.title,
            "original_filename": self.original_filename,
            "byte_size": self.byte_size,
            "page_count": self.page_count,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            # storage_key is deliberately absent. It is the one field that
            # would let a client address the private PDF if the bucket were
            # ever misconfigured, and no client has any use for it.
        }
        if include_pages:
            data["pages"] = [page.to_dict() for page in self.pages]
        return data
