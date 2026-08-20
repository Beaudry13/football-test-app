"""Which existing programs a typed team name might already be.

WHAT THIS IS FOR
----------------
`AccessRequest` is the one path where somebody still TYPES a program name -
they have no account yet, so there is nothing to copy it from. That is where
"UC", "Cincinnati", "University of Cincinnati" and "Cincinnati Football"
become four isolated programs with one coach each.

The staff-invite path already removes the typing for everyone joining an
existing program. This covers the remaining case by answering one question at
review time: HAS SOMEBODY LIKE THIS ALREADY SIGNED UP?

A REVIEW HINT, AND NOTHING ELSE
-------------------------------
Nothing here merges, links, blocks or auto-fills. It returns a list for a
human to read before deciding whether this person starts a new program or
should be sent a staff invite into an existing one. Automatically combining
two organizations because their names look alike would hand a stranger
somebody else's film, roster and results - the exact failure the whole
organization model is built to prevent.

That is the same rule `organization_merge._normalize` already states: "This
never drives an automatic action." This module reuses that function rather
than inventing a second idea of what "the same name" means.

WHY THE MATCHING IS DELIBERATELY CRUDE
---------------------------------------
Token overlap after dropping filler words, plus a containment check. No
Levenshtein, no phonetics, no scoring model, and above all NO SCHOOL
DIRECTORY. A national database would be a project in itself and would still
miss "UC"; a human reading five candidate names solves this in a second, and
is the only thing that can tell a real match from a coincidence.

The cost of a false positive here is one line of output somebody ignores. The
cost of a false negative is a duplicate program, which the existing merge tool
already knows how to fix. Both are cheap, so the matching does not need to be
clever - it needs to be UNSURPRISING.
"""

from __future__ import annotations

import re

from app.models import Coach, Organization
from app.services.organization_merge import _normalize

#: Words that carry no distinguishing signal in a program name. "University of
#: Cincinnati" and "Cincinnati Football" share exactly one useful token, and it
#: is the one that matters.
FILLER = frozenset(
    {
        "football",
        "the",
        "of",
        "university",
        "univ",
        "college",
        "high",
        "school",
        "hs",
        "academy",
        "athletics",
        "program",
        "team",
        "varsity",
    }
)


def tokens(name: str) -> set[str]:
    """The words in a name that actually distinguish it.

    Normalised through `organization_merge._normalize` first - casefolded and
    stripped of accents - so this cannot disagree with the merge tool about
    what two names look like.
    """
    words = re.split(r"[^0-9a-z]+", _normalize(name))
    return {w for w in words if w and w not in FILLER}


def looks_similar(a: str, b: str) -> bool:
    """Whether a human reviewing these two names should be shown both.

    True when they share a distinguishing word, or when one normalised name
    contains the other ("UC" inside "UC Bearcats"). Deliberately generous:
    an extra candidate costs a glance, a missed one costs a duplicate program.
    """
    a_tokens, b_tokens = tokens(a), tokens(b)
    if not a_tokens or not b_tokens:
        # NOTHING DISTINGUISHING TO MATCH ON. Every program is "<somewhere>
        # Football", so a name made only of filler must match nothing rather
        # than everything - a hint that fires on every request is worse than
        # no hint, because it gets ignored.
        return False
    if a_tokens & b_tokens:
        return True
    # Containment catches a run-together name ("UCBearcats" against "UC
    # Bearcats") that shares no whole word. Reached only once both sides have
    # something distinguishing, or "football" would be inside half of them.
    left, right = _normalize(a).replace(" ", ""), _normalize(b).replace(" ", "")
    return left in right or right in left


def candidates_for(team_name: str | None, limit: int = 5) -> list[dict]:
    """Existing programs a typed team name might already be.

    Empty for a request that named no team - guessing from an email domain
    would be a different feature with a different failure mode, and this one
    is allowed to say "nothing to show".

    Each entry carries enough for a human to judge: the program, how many
    coaches are already in it, and its id, which is what an eventual staff
    invite would be aimed at.
    """
    if not (team_name or "").strip():
        return []

    matches = []
    for org in Organization.query.order_by(Organization.id).all():
        if not looks_similar(team_name, org.name):
            continue
        matches.append(
            {
                "organization_id": org.id,
                "name": org.name,
                "coach_count": Coach.query.filter_by(organization_id=org.id).count(),
            }
        )
        if len(matches) >= limit:
            break
    return matches
