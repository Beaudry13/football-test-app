"""Which options a player selected — a SET, not a single choice.

WHY THIS TABLE EXISTS
---------------------
`answers.selected_option_id` is one nullable FK: one question, one chosen
option. That is the whole of the current product and it works, but it cannot
express "select all that apply", and it cannot express a future question whose
choices are regions on a photograph rather than lines of text.

This table records the SET. `answers.selected_option_id` is deliberately kept
alongside it during the transition - see the note at the bottom.

`option_id` HAS NO FOREIGN KEY, AND THAT IS DELIBERATE
------------------------------------------------------
**Do not "fix" this by adding a FK to `question_options`.** It is absent on
purpose, and the reason is the same one that governs the rest of this codebase:
what a player did is a HISTORICAL FACT, and history must not depend on live
authoring rows continuing to exist.

The three alternatives were each considered and rejected:

* `ON DELETE CASCADE` would silently SHRINK a recorded answer. A player who
  selected A + C + D would, after someone deleted option C, be recorded as
  having selected A + D. That is worse than the behaviour it replaces:
  `answers.selected_option_id` is `ON DELETE SET NULL`, which loses the pointer
  but keeps the answer row and its grade.
* `ON DELETE SET NULL` is impossible - `option_id` is half the primary key.
* `ON DELETE RESTRICT` would make deleting a question or a quiz depend on the
  order Postgres happens to process two cascades, which is not something to
  build a delete path on.

So the id is stored as a plain integer, exactly as
`attempt_question_snapshots` stores its content as JSONB and lets its
`question_id` go NULL. The MEANING of a selection - the option's wording, and
whether it was correct - is resolved from the delivered snapshot, which is
immutable and always present for a post-Phase-1 attempt. The live option row is
not, and never was, the source of historical truth.

WHAT THIS COSTS, AND WHO PAYS IT
--------------------------------
No database-level referential integrity for live options. That obligation moves
to the application: **every write must validate that each option id belongs to
the question being answered and was actually delivered to this attempt.** Ids
arriving from a client are never trusted. The database is relieved of the check
because history must outlive the rows; the API is not.

SET SEMANTICS ARE ENFORCED BY THE PRIMARY KEY
---------------------------------------------
`PRIMARY KEY (answer_id, option_id)` makes selecting the same option twice
impossible, so "a set" is a property of the schema rather than something
validation has to remember. Order is not stored because order does not exist in
a set - and exact-set grading must never depend on the sequence a player
happened to tap.
"""

from app.extensions import db


class AnswerSelectedOption(db.Model):
    __tablename__ = "answer_selected_options"

    #: CASCADE, unlike `option_id` above: a selection has no meaning without the
    #: answer it belongs to, and deleting an attempt should take its selections
    #: with it exactly as it takes its answers.
    answer_id = db.Column(
        db.Integer,
        db.ForeignKey("answers.id", ondelete="CASCADE"),
        primary_key=True,
    )
    #: PLAIN INTEGER, NO FOREIGN KEY - read the module docstring before
    #: changing this. It records which option was chosen at the time of
    #: answering, and must survive that option row being deleted.
    option_id = db.Column(db.Integer, primary_key=True, nullable=False)

    answer = db.relationship("Answer", back_populates="selected_options")

    def __repr__(self) -> str:
        return f"<AnswerSelectedOption answer={self.answer_id} option={self.option_id}>"
