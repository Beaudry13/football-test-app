"""Shared player-name list normalization, used by both Roster and Group
player-list saves (`app/routes/rosters.py`, `app/routes/groups.py`).
"""

from app.errors import ApiError


def normalize_and_validate_names(
    raw_names: list[str], allow_empty: bool = False
) -> list[str]:
    """Trims whitespace, drops empties, and rejects duplicate names
    (case-insensitive).

    A duplicate isn't silently deduped: two entries for the same name would
    let a player validate but then collide with the unique-per-player
    constraint at submit time, and would also make two genuinely different
    people with the same name unable to both take the quiz. Better to make
    the coach fix the list (e.g. "Jordan Smith / Jordan Smith Jr.") than to
    silently drop one.
    """
    names = [name.strip() for name in raw_names]
    names = [name for name in names if name]
    if not names and not allow_empty:
        # `allow_empty` is passed by the legacy whole-list editors, which are
        # now removal-only in the UI: clearing the final legacy entry sends an
        # empty list and must succeed, or that last row is permanent. An empty
        # CSV upload still fails - that is a mistaken file, not an intent.
        raise ApiError("List must have at least one player name", status_code=422)

    seen_lower: set[str] = set()
    for name in names:
        lowered = name.lower()
        if lowered in seen_lower:
            raise ApiError(f'Duplicate player name: "{name}"', status_code=422)
        seen_lower.add(lowered)

    return names
