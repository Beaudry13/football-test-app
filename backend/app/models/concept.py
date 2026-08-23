from app import db


class Concept(db.Model):
    """What a question is ABOUT - one flat, organization-owned label.

    The point of this table is a question a coach cannot currently ask: "what
    does my team not know?" Scores answer it per quiz and per question, which
    is per ARTEFACT rather than per IDEA - two questions about Cover 3 written
    six weeks apart have nothing linking them. A concept is that link.

    ONE PER QUESTION, FLAT, AND NULLABLE. No hierarchy, no many-to-many. A
    question with no concept is not an error: NULL reads as "General", and
    every question written before this table existed is in that state honestly
    rather than being guessed into a bucket.

    ARCHIVED, NOT DELETED, and that is a historical-truth rule rather than a
    tidiness one. Attempts record the concept they were delivered under inside
    the immutable question snapshot, so an old attempt keeps reading correctly
    whatever happens here. But the LIVE side still has to resolve a name for a
    concept a coach has retired, and a hard delete would leave every question
    that used it silently untagged. `is_archived` takes it out of the pickers
    and leaves the history intact.
    """

    __tablename__ = "concepts"

    id = db.Column(db.Integer, primary_key=True)
    #: Concepts belong to an ORGANIZATION, not to a coach. Two coaches on the
    #: same staff tagging "Cover 3" must land on the same concept, or the
    #: analysis this exists for splits in half.
    organization_id = db.Column(
        db.Integer,
        db.ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    name = db.Column(db.String(80), nullable=False)
    is_archived = db.Column(db.Boolean, nullable=False, default=False, server_default=db.false())
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now())

    organization = db.relationship("Organization")

    __table_args__ = (
        #: CASE-INSENSITIVE, because "Cover 3" and "cover 3" are one idea and
        #: allowing both would quietly halve every count built on this. A
        #: functional index rather than storing a normalised copy: one source
        #: of truth for the name, and the coach's own capitalisation survives.
        #:
        #: Deliberately NOT filtered on is_archived. Archiving frees nothing -
        #: re-creating an archived name would make two rows that mean the same
        #: thing, which is the exact split this prevents. Un-archive instead.
        db.Index(
            "uq_concept_name_per_org",
            organization_id,
            db.func.lower(name),
            unique=True,
        ),
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "is_archived": self.is_archived,
        }
