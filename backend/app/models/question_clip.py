"""A short silent looping video attached to a question.

WHY THIS IS NOT `question_images`
---------------------------------
`question_images` is one row per question and carries `annotations` plus
`canvas_width` - the pinned Fabric coordinate space a coach's shapes were
drawn against. A clip has no coordinate space, cannot be annotated, and would
have to compete with a still for that table's single slot. Widening it would
attach an annotation model to something that has no frames to annotate.

WHY THE BYTES ARE NOT IN `file_storage`
---------------------------------------
That interface validates image extensions, pushes everything through Pillow
and re-encodes to JPEG. A video handed to it fails at `Image.open()`. Clips
follow `private_storage` instead - opaque keys, no public URL, served through
the signed `/media/<token>` route - which is the same reasoning that put
playbook PDFs there.

WHAT IS STORED, AND WHAT DELIBERATELY IS NOT
--------------------------------------------
Two storage keys and the few facts a renderer needs before the video loads.
No bitrate, no codec string, no frame count: none of it is read by anything,
and speculative columns are how a schema stops describing the product.

`content_type` IS stored, because the signed media route has to answer with
the right `Content-Type` and guessing from an opaque key is not possible.

ONE CLIP PER QUESTION, and it is a third alternative rather than an addition:
a question takes its visual material from an uploaded still, OR a playbook
page region, OR a clip. That rule is enforced in the service layer exactly
where the existing image/region rule is enforced - see routes/questions.py.
"""

from app.extensions import db


class QuestionClip(db.Model):
    __tablename__ = "question_clips"

    id = db.Column(db.Integer, primary_key=True)
    question_id = db.Column(
        db.Integer,
        db.ForeignKey("questions.id"),
        nullable=False,
        unique=True,
        index=True,
    )

    #: Opaque private-storage key. NEVER a URL - there is no public base to
    #: build one from, which is what keeps a clip unaddressable without a
    #: signed token.
    storage_key = db.Column(db.String(512), nullable=False)

    #: The still frame captured in the browser at record time. Everything that
    #: cannot render motion uses it: PDF export, list thumbnails, and the
    #: `poster` attribute that covers the moment before playback starts.
    poster_key = db.Column(db.String(512), nullable=True)

    #: Stored rather than derived: the signed media route must answer with a
    #: real Content-Type, and an opaque key carries no extension to infer from.
    content_type = db.Column(db.String(128), nullable=False)

    #: Milliseconds, as reported by the browser after recording. Display only.
    duration_ms = db.Column(db.Integer, nullable=True)

    #: Lets a renderer reserve the right box before any bytes arrive, so the
    #: question does not jump when the video loads.
    width = db.Column(db.Integer, nullable=True)
    height = db.Column(db.Integer, nullable=True)

    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now())

    question = db.relationship("Question", back_populates="clip")

    def to_dict(self) -> dict:
        """Metadata only. The playable URL is minted per request by the route
        that serves it, because a signed token expires and must never be
        cached into a payload that outlives it."""
        return {
            "id": self.id,
            "question_id": self.question_id,
            "content_type": self.content_type,
            "duration_ms": self.duration_ms,
            "width": self.width,
            "height": self.height,
            "has_poster": self.poster_key is not None,
        }
