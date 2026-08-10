"""Counts attempts that carry no canonical player, and how repairable they are.

READ-ONLY. This script writes nothing and relinks nothing. Repairing history
is a separate, human-approved decision - see the "Reconcile Legacy Attempts"
proposal in docs/IMPROVEMENT-BANK.md.

    python tools/unlinked_attempt_audit.py

Reports counts and per-organization totals only. Player names are summarised,
never listed: the point is to size the problem and decide whether an
automated pass is safe, and that needs shapes, not identities.
"""

import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import create_app  # noqa: E402
from app.models import Player, PlayerAttempt, Quiz  # noqa: E402
from app.services.player_matching import normalise_name  # noqa: E402


def audit() -> dict:
    unlinked = (
        PlayerAttempt.query.join(Quiz, Quiz.id == PlayerAttempt.quiz_id)
        .filter(PlayerAttempt.player_id.is_(None))
        .with_entities(PlayerAttempt.id, PlayerAttempt.player_name, Quiz.organization_id)
        .all()
    )

    # Canonical names per organization, so a match is only ever considered
    # inside the organization that owns the quiz.
    by_org: dict[int, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for player in Player.query.with_entities(
        Player.organization_id, Player.first_name, Player.last_name
    ).all():
        org, first, last = player
        by_org[org][normalise_name(f"{first} {last}")] += 1

    unique_match = 0
    no_match = 0
    ambiguous = 0
    orgs_affected = set()

    for _attempt_id, player_name, org_id in unlinked:
        orgs_affected.add(org_id)
        count = by_org.get(org_id, {}).get(normalise_name(player_name or ""), 0)
        if count == 1:
            unique_match += 1
        elif count == 0:
            no_match += 1
        else:
            ambiguous += 1

    return {
        "total_attempts": PlayerAttempt.query.count(),
        "unlinked_attempts": len(unlinked),
        "unique_exact_match": unique_match,
        "no_match": no_match,
        "ambiguous": ambiguous,
        "organizations_affected": len(orgs_affected),
    }


if __name__ == "__main__":
    app = create_app()
    with app.app_context():
        result = audit()

    print("=== Unlinked attempt audit (read-only) ===")
    print(f"  attempts, total           : {result['total_attempts']}")
    print(f"  attempts with no player_id: {result['unlinked_attempts']}")
    print()
    print("  Of the unlinked, by how repairable they are:")
    print(f"    exactly one name match  : {result['unique_exact_match']}  (reviewable)")
    print(f"    no match at all         : {result['no_match']}  (needs a new Player, or is a typo)")
    print(f"    several players share it: {result['ambiguous']}  (human choice REQUIRED)")
    print()
    print(f"  organizations affected    : {result['organizations_affected']}")
