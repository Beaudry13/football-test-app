# Connected system: create once, grade fast

From the connected-system cycle, 22 October 2026, on branch
`feature/connected-system`. None of this is deployed.

This document covers what PEIRA reuses so the coach does not type something
twice, and how grading by hand got faster. Preview 3D has its own document:
`MOTION-LAB-3D-PRODUCTION.md`.

## Create once: Motion Lab is the source

### "What have I already made from this play?"

`GET /api/quizzes/made-from-play/<play_id>` (in `routes/reps.py`) returns two
things.

`made` lists this coach's quizzes and Reps that hold a **live** question made
from the play. A retired question does not count. The list is newest first,
and each entry has `from_play` (how many of its questions came from this play)
and `question_count`.
- It is own-only, like every quiz list.
- Another organization's coach gets an empty list.
- Nothing about the play itself is returned.

`last` is what the coach said the last time he made something from the play,
taken verbatim from his latest question: `concept` (null if it has been
archived), `subject_man` and `subject_role`.

The endpoint is read-only. A question's picture, answer, presnap clip and
delivered snapshots are its own copies, so editing the play never rewrites
anything already made or delivered.

Motion Lab's **Use this play** menu lists the results under "Made from this
play", but only when there is something to list. Each row opens the quiz
editor or the Rep page.

### Starting values the panels take

Every one of these is visible and can be changed. None is inferred football;
each is either the coach's own earlier entry or his current selection.

| Field | Make a quiz question | Make a rep |
|---|---|---|
| The man | the man selected on the field | the man selected on the field, then this device's memory for the play, then the server's `last` |
| Role | (in the question's words: "You're the Z.") | the selected man's role name, then memory, then `last` |
| Concept | this device's memory for the play, then the server's `last` | the same |
| Where it goes | the quiz last used for a question, else the quiz that already holds this play ("· has this play"), else a new quiz named after the play | the Rep the last decision went into, else the Rep made from this play, else a new one |

A few more rules:
- Making a question keeps the coach in Motion Lab. The panel then offers
  "Make another" (the same quiz and concept, nobody marked) or "Open quiz".
- The concept and man it used are handed on to Make rep through
  `peira.makeRep.v1`.
- Make question no longer offers Reps as a place to put a quiz question.
- Draw your assignment still takes the man's authored route as the answer
  drawing, and only that route. A man with no route gets no answer drawing.

### The links back to the play

These are coach-only, and only for coaches who can open Motion Lab
(`useMayUseMotionLab`):
- the quiz editor's question menu ("Open the play");
- the grading screen's header;
- Results problem cards (from before this cycle);
- Rep results (from before this cycle);
- Teach (from before this cycle).

## Grade fast: drawings and written answers

The grading screen is `GradeResponsesPage`, one question at a time.

One answer is **current**, shown with a gold outline. The keys work only when
focus is not in a text field:

| Key | Action |
|---|---|
| C / X | correct / incorrect; the cursor then moves to the next answer still waiting, scrolled in under the sticky question |
| ← → (J K) | move the cursor |
| A | lay the coach's answer over every drawing, or take it off |
| U | Ungraded only |
| N | next question |

How decisions behave:
- A decision shows at once. The one write follows, and if the server refuses
  it, the decision is undone and the screen says so.
- The page no longer reloads the quiz, the responses and the dashboard after
  each grade.
- **Ungraded only** is offered once anything has been decided. An answer
  decided while it is on stays on screen, marked, until the coach moves on,
  so a misclick is still visible.

What the screen shows:
- Progress reads "Question 3 · 7 of 11 graded · 9 left on this quiz".
- Beside the question: the concept, who he is (`subject_role`), and "Open the
  play".

There is deliberately **no "mark all correct"**, and a test pins its absence.
Every answer gets a look, and grading stays with the coach. Drawings are never
graded automatically.

Practice versus graded policy is unchanged. Grading writes `answers.is_correct`
through the existing `PATCH /api/answers/<id>/grade`, as before.
