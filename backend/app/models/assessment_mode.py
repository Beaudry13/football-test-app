"""How an assignment is being used: for a grade, or for practice.

THE QUIZ IS THE CONTENT; THE ACCESS CODE IS HOW IT IS BEING USED.
One "Cover 3 Install" quiz can be sent as practice on Tuesday and as a graded
assessment on Friday, with no duplicated content.

WHY A STRING AND NOT A POSTGRES ENUM
------------------------------------
A native enum is a one-way door here: values can never be removed, and
`ALTER TYPE ... ADD VALUE` cannot run in the transaction that created it
(see CLAUDE.md, and the questiontype migration that had to be split). Mode is
young and likely to grow, so it is a VARCHAR with a CHECK constraint -
adding a third mode later is an ordinary reversible migration.
"""

GRADED = "GRADED"
PRACTICE = "PRACTICE"

#: Every valid mode. The CHECK constraint in the migration is generated from
#: this, so the database and the application cannot disagree about the set.
ASSESSMENT_MODES = (GRADED, PRACTICE)

#: What an access code is unless someone says otherwise. Every existing code,
#: and every existing attempt, is GRADED - which is what makes this feature
#: invisible to current data.
DEFAULT_MODE = GRADED
