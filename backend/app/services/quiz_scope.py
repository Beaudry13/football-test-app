"""Which quizzes and folders a coach sees, and which an admin sees.

THE RULE, once, in one file
---------------------------
Coach View is own-only for everyone, including admins. Admin View is
organization-wide and lives behind admin-only endpoints. Nothing in between,
and no scope parameter on a coach endpoint that a client could flip.

`utils.auth.own_quizzes_query` is the query-level half of this. This module
holds the parts that need more than a WHERE clause: folder relevance, and the
id sets that scope player analytics.
"""

from __future__ import annotations

from app.models import Folder, Quiz


def owned_quiz_ids(coach) -> list[int]:
    """The ids of every quiz this coach created. Used to scope player
    analytics, which join through attempts rather than listing quizzes."""
    rows = (
        Quiz.query.with_entities(Quiz.id)
        .filter(Quiz.organization_id == coach.organization_id, Quiz.coach_id == coach.id)
        .all()
    )
    return [row[0] for row in rows]


def visible_folders(coach, folders: list[Folder], quizzes: list[Quiz]) -> list[Folder]:
    """The folders worth showing a coach in Coach View.

    A folder is shown when:
      1. the coach created it, or
      2. it directly holds one of the coach's quizzes, or
      3. it is an ANCESTOR of a folder shown under 1 or 2.

    Rule 3 is the one that is easy to miss and breaks navigation when missed.
    A coach's quizzes may live in FALL CAMP > INSTALL QUIZ; without walking
    the parent chain, INSTALL QUIZ qualifies but FALL CAMP does not, and the
    subfolder becomes unreachable from the dashboard - present in the data,
    absent from the tree, and impossible to click to.

    Computed in Python rather than as a recursive CTE: an organization has
    tens of folders, they are already loaded for the response, and a readable
    parent walk is worth more here than a query that saves nothing.
    """
    by_id = {folder.id: folder for folder in folders}
    owned_quiz_folder_ids = {quiz.folder_id for quiz in quizzes if quiz.folder_id is not None}

    keep: set[int] = set()
    for folder in folders:
        if folder.coach_id == coach.id or folder.id in owned_quiz_folder_ids:
            keep.add(folder.id)

    # Walk up from every kept folder, adding ancestors. Bounded by a seen-set
    # so a cycle introduced by bad data cannot spin forever - parent_folder_id
    # is RESTRICT-constrained rather than cycle-proof.
    for folder_id in list(keep):
        seen: set[int] = set()
        current = by_id.get(folder_id)
        while current is not None and current.parent_folder_id is not None:
            if current.id in seen:
                break
            seen.add(current.id)
            keep.add(current.parent_folder_id)
            current = by_id.get(current.parent_folder_id)

    return [folder for folder in folders if folder.id in keep]
