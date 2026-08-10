"""Resolving a typed or imported name to a canonical master-roster Player.

WHY THIS EXISTS
---------------
An attempt with `player_id = NULL` is invisible to every canonical analytics
surface: the player profile, the cumulative performance report, and anything
built on `PlayerAttempt.player_id`. Roster and group entries created from
bare names produced exactly that, so a coach could assign a quiz, watch a
player take it, and never see the result attributed to them.

This module is the single place that decides which canonical Player a name
refers to.

THE MATCHING RULE, AND WHAT IT REFUSES TO DO
--------------------------------------------
Exact match on the normalised full name. Case-insensitive and
whitespace-collapsed, and nothing else:

  * NO fuzzy matching. "Jon Smith" is not "John Smith", and a report that
    silently attributed one player's scores to another would be worse than
    no report.
  * NO picking the first row when several match. Two real people can share a
    name - `play.py` already notes that a name-only lookup "can't tell them
    apart and would silently return whichever row the query happens to find
    first". Ambiguity is returned to the caller, which surfaces it to the
    coach, who is the only one who knows.
  * NO matching across organizations. Every query is org-scoped.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from app.models import Player


def normalise_name(name: str) -> str:
    """Case-folded, whitespace-collapsed. The comparison key, never stored.

    Deliberately conservative: it does not strip punctuation, suffixes or
    accents. Every extra normalisation is another way two different people
    collapse into one, and this is the function that decides whose scores
    belong to whom.
    """
    return re.sub(r"\s+", " ", (name or "").strip()).casefold()


@dataclass
class NameResolution:
    """What an organization's roster says about a list of names."""

    # name as supplied -> the Player it unambiguously refers to
    matched: dict[str, Player] = field(default_factory=dict)
    # names no canonical Player has
    unmatched: list[str] = field(default_factory=list)
    # name as supplied -> how many canonical Players share it
    ambiguous: dict[str, int] = field(default_factory=dict)

    @property
    def has_ambiguity(self) -> bool:
        return bool(self.ambiguous)


def resolve_names(organization_id: int, names: list[str]) -> NameResolution:
    """Map each name to exactly one canonical Player, or say why it cannot.

    One query for the whole list rather than one per name: an import of a
    sixty-player squad should not be sixty round trips.

    Inactive players are included. A deactivated player is still the same
    person, and refusing to match them would mint a duplicate Player for
    somebody the organization already knows about.
    """
    resolution = NameResolution()
    if not names:
        return resolution

    wanted = {normalise_name(name) for name in names}
    by_key: dict[str, list[Player]] = {}
    for player in Player.query.filter_by(organization_id=organization_id).all():
        key = normalise_name(player.full_name)
        if key in wanted:
            by_key.setdefault(key, []).append(player)

    for name in names:
        candidates = by_key.get(normalise_name(name), [])
        if len(candidates) == 1:
            resolution.matched[name] = candidates[0]
        elif not candidates:
            resolution.unmatched.append(name)
        else:
            resolution.ambiguous[name] = len(candidates)

    return resolution


def ambiguity_message(ambiguous: dict[str, int]) -> str:
    """The error a coach sees when a name could mean two people.

    Names the people involved and asks for a choice, because "import failed"
    with no detail leaves them with nothing to act on.
    """
    parts = [
        f'{count} players named "{name}" are on your roster'
        for name, count in sorted(ambiguous.items())
    ]
    listed = "; ".join(parts)
    return (
        f"{listed}. Add these players from the roster picker instead, so the "
        "right person is chosen."
    )


def resolve_or_create_players(organization_id: int, names: list[str]) -> list[Player]:
    """The canonical Player for each name, creating any the roster lacks.

    THE RULE, in order:
      * exactly one canonical Player with that name -> use it
      * none                                        -> create it
      * two or more                                 -> refuse the whole call

    Creating on a zero-match carries no identity risk: a name nobody on the
    roster has cannot be confused with anybody. It also keeps the master
    roster as the single source of truth, which is the point - a group import
    that quietly built a parallel name-only list is how attempts ended up
    invisible to reporting.

    Refusing on ambiguity is the other half. Silently taking the first row
    would attribute one real person's quiz scores to another, and no import
    convenience is worth that. The coach picks, via the roster picker.

    Rejects the ENTIRE call rather than importing the unambiguous rows and
    skipping the rest: a partially applied import leaves the coach unsure
    which half happened.
    """
    from app.errors import ApiError
    from app.extensions import db
    from app.services.roster_import import _split_full_name

    resolution = resolve_names(organization_id, names)
    if resolution.has_ambiguity:
        raise ApiError(ambiguity_message(resolution.ambiguous), status_code=422)

    created: dict[str, Player] = {}
    for name in resolution.unmatched:
        # Same name twice in one file resolves to one Player, not two.
        key = normalise_name(name)
        if key in created:
            continue
        first, last = _split_full_name(name)
        player = Player(organization_id=organization_id, first_name=first, last_name=last)
        db.session.add(player)
        created[key] = player

    # Flushed so every Player has an id before anything links to it.
    if created:
        db.session.flush()

    ordered: list[Player] = []
    for name in names:
        player = resolution.matched.get(name) or created.get(normalise_name(name))
        if player is not None:
            ordered.append(player)
    return ordered
