"""Recording somebody who has asked to be let into the beta.

THE WHOLE SURFACE IS ONE FUNCTION, AND IT CANNOT FAIL VISIBLY
-------------------------------------------------------------
`record` returns nothing. That is deliberate: there is no outcome the caller
is allowed to tell the person apart by. First request and hundredth request,
brand-new address and one that already has an account - all the same calm
answer.

WHY THAT MATTERS. A form that says "you have already requested access" is a
form that answers "is this address known to Peira" for anybody who types one
in. The same is true of "that email already has an account". A request form is
open to the whole internet by design, so it must not become a way to test
whether a particular coach uses this product.

THE INSERT IS ON CONFLICT DO NOTHING, NOT CHECK-THEN-INSERT
------------------------------------------------------------
Two submissions of the same form - a double click, a retried request - are a
genuine race, and the same one `services/attempts` and both invite types deal
with. Looking first and inserting second would let both pass the look and one
of them raise an IntegrityError, turning a duplicate request into a 500 for
somebody who did nothing wrong. The database decides, and DO NOTHING means the
FIRST request time survives: how long somebody has been waiting is the useful
number, not when they last got impatient.
"""

from __future__ import annotations

from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.extensions import db
from app.models import AccessRequest

#: What every submission is told, whatever happened underneath.
REQUEST_RECEIVED = "Thanks - we have your request and will be in touch."


def normalise_email(raw: str) -> str:
    """Trim and lower-case, and nothing cleverer than that.

    Enough that `Coach@Example.com ` and `coach@example.com` are one person,
    which is what makes the unique constraint mean something.

    DELIBERATELY NOT stripping dots or `+tags`: those are Gmail conventions,
    not email ones, and applying them everywhere would silently merge two
    genuinely different addresses at providers that treat them as distinct.
    Wrongly merging two coaches into one request is worse than keeping two.
    """
    return (raw or "").strip().lower()


def record(name: str, email: str, team: str | None = None) -> None:
    """Note that this person asked. Idempotent, and silent about the outcome.

    Returns None on purpose - see the module docstring. A caller that could
    learn whether the row was new would eventually tell somebody.
    """
    cleaned_name = (name or "").strip()
    cleaned_team = (team or "").strip() or None

    db.session.execute(
        pg_insert(AccessRequest)
        .values(
            name=cleaned_name,
            email=normalise_email(email),
            team=cleaned_team,
            requested_at=AccessRequest.now(),
        )
        .on_conflict_do_nothing(index_elements=["email"])
    )
    db.session.commit()
