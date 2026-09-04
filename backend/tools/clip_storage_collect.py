"""Report, and optionally reclaim, clip objects nothing references any more.

    python tools/clip_storage_collect.py             # DRY RUN - changes nothing
    python tools/clip_storage_collect.py --execute   # deletes the listed objects

DRY RUN IS THE DEFAULT AND IT IS ENFORCED
------------------------------------------
Without --execute the script pins itself to a `SET TRANSACTION READ ONLY`
transaction, the same guard `production_cleanup.py` uses: Postgres refuses
every write, so a dry run cannot change the database even if this file is later
edited carelessly. It also never asks for a storage client, so it cannot delete
an object either.

WHY THIS IS A TOOL AND NOT A SCHEDULED JOB
-------------------------------------------
Peira has no worker, no queue and no scheduler, and this does not justify
introducing one. Orphaned clips accumulate at the rate a coach re-records film
- single digits a week - so a run whenever anyone looks is comfortably ahead of
the problem, and the reclaim is not time-critical by construction: everything
here has already waited out a 30-day grace period.

The valuable half of this work is the DECISION, in `services/clip_gc.py`, which
is fully tested. Automating the trigger adds infrastructure and removes a human
reading the list before anything is deleted. That trade is not worth making
until the volume says otherwise.

WHAT IT WILL NEVER TOUCH
------------------------
Only objects Peira itself recorded in `unlinked_clip_objects` as clip video or
clip posters. It never enumerates storage, so a playbook PDF, a rendered page,
a page thumbnail and a masked region are all unreachable from here regardless
of what else is wrong.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import sqlalchemy as sa

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402
from app.services import clip_gc  # noqa: E402


def _describe(plan: clip_gc.CollectionPlan, grace_days: int) -> None:
    print("CLIP STORAGE COLLECTION")
    print("=" * 62)
    print(f"grace period          : {grace_days} days")
    print(f"unlink records total  : {plan.total_candidates}")
    print(f"  still referenced    : {plan.still_referenced}  (live quiz or delivered attempt)")
    print(f"  inside grace period : {plan.within_grace}")
    print(f"  already collected   : {plan.already_collected}")
    print(f"  COLLECTABLE         : {len(plan.collectable)}")

    if not plan.collectable:
        print("\nNothing to reclaim.")
        return

    print("\nobjects that would be deleted:")
    for candidate in plan.collectable:
        unlinked = candidate.unlinked_at.isoformat() if candidate.unlinked_at else "unknown"
        print(f"  [{candidate.kind:6}] {candidate.storage_key}  unlinked {unlinked}")


def run(*, execute: bool, grace_days: int) -> dict:
    app = create_app()
    with app.app_context():
        if not execute:
            # Belt and braces: the plan is already read-only, but a dry run
            # should be incapable of writing rather than merely not writing.
            db.session.execute(sa.text("SET TRANSACTION READ ONLY"))

        plan = clip_gc.plan_collection(grace_days=grace_days)
        _describe(plan, grace_days)

        if not execute:
            print("\nDRY RUN - nothing was deleted. Re-run with --execute to reclaim.")
            return {"plan": plan, "result": None}

        result = clip_gc.execute_collection(plan)
        print(f"\ndeleted {len(result.deleted)} object(s)")
        for key in result.failed:
            # Loud and specific. A failed delete leaves the row uncollected, so
            # the next run retries it - but an operator should know that
            # storage said no rather than discovering it from a count.
            print(f"  FAILED (left for the next run): {key}")
        return {"plan": plan, "result": result}


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Reclaim clip objects that nothing references any more."
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="actually delete. Without this the script only reports.",
    )
    parser.add_argument(
        "--grace-days",
        type=int,
        default=clip_gc.GRACE_PERIOD_DAYS,
        help=(
            "how long an unlinked object is kept before it can be collected "
            f"(default {clip_gc.GRACE_PERIOD_DAYS}). Lowering this is an "
            "operator decision, not a routine flag."
        ),
    )
    args = parser.parse_args(argv)
    if args.grace_days < 0:
        parser.error("--grace-days cannot be negative")
    run(execute=args.execute, grace_days=args.grace_days)


if __name__ == "__main__":
    main()
