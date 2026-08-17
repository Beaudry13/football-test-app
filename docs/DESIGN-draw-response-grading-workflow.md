# Draw Response — the coach's grading workflow

## FUTURE DESIGN / NOT IMPLEMENTED

**Nothing in this document is built.** It is a design sketch for work that has
never been started, kept because the reasoning in it is not recorded anywhere
else.

**This document does NOT describe how Draw Response works.** Draw Response v1
shipped in August 2026 and is complete: authoring, drawing, server-side
persistence, historical image binding, cross-device resume, coach results,
player results, CSV and detailed-PDF export. For how any of that actually
works, read `CLAUDE.md` and the test suites — `test_drawing_image_binding.py`,
`test_drawing_resume.py`, `test_player_results_drawing.py`,
`test_export_drawings.py`. Those are authoritative. This is not.

### What was removed from this document, and why

An earlier draft carried an export and rendering architecture that the
implementation then disproved. It has been deleted rather than corrected,
because a design doc contradicting shipped code is worse than no design doc:

| Removed | What actually shipped |
|---|---|
| "ReportLab needs a raster; render PNGs at submit and store them" | ReportLab draws the strokes as **vector paths** at export time, ~160ms per roster. No raster, no stored PNG. |
| `answer_drawings.preview_url` as the export mechanism | Unused. The canonical JSON is rendered directly. |
| CSV showing stroke counts and a preview URL | CSV says `Drawing submitted` / `No drawing`. A cell that cannot show a drawing does not pretend to summarise it. |
| "Replace the DrawingViewer canvas with inline SVG" | The canvas viewer was kept and is now shared by coach **and** player results. |

The sequencing section went with them: it was ordered around work that has
since happened in a different order, and around the SVG rewrite that was never
needed.

---

## 1. The workflow problem

The Results page is organised by player: expand a row, see that player's
answers, grade them. That is right for "how did Jordan do".

It is wrong for the job a coach actually has on Monday morning: **twenty
players answered the same question, and I need to judge them.** Grading
per-player means re-establishing the question's context forty times, and it
makes consistency almost impossible — the standard drifts between the first
player and the last.

### Recommendation: a per-question queue ALONGSIDE the player rows

Not instead of. Two views over the same data, each matching a real task:

- The Results tab keeps its player rows — that page works.
- A new entry point ("**12 drawings to review**") opens a focused queue: one
  question, every player's drawing, graded in sequence.

**Queue design notes:**
- One question at a time, its text pinned at the top
- Drawings in a responsive grid, each with the player's name clearly attached —
  **the attribution mistake is the unforgivable one**
- Correct / Incorrect on each card, no expansion for the common case
- Progress ("8 of 20 reviewed"), and the queue does not lose position on grade
- **Coach-controlled order.** Default by jersey number to match the roster a
  coach thinks in; optionally randomised, which is a genuine fairness feature
  when grading subjective work

---

## 2. Partial credit — the reasoning worth keeping

A drawing is the most obviously partial-credit-shaped thing in the product. A
run fit can be three-quarters right. **The temptation is real, and this is the
argument against it.**

The grading vocabulary is fixed and shared:

> CORRECT / INCORRECT / NOT_GRADED / UNANSWERED, and
> `score = correct / (correct + incorrect)` — never counting ungraded or
> unanswered, never fabricating 0% when nothing is graded.

Since Phase 2 that rule lives once, in `services/scoring.py`, and is consumed
by the Results tab, quiz cards, the dashboard, the CSV and both PDFs. **Any
change to what a grade IS has to land in all of them at once, or they start
disagreeing.**

Adding a 0–100 score means `score = sum(points) / sum(possible)` replaces
`correct / (correct + incorrect)` everywhere. Every existing boolean grade has
to be reinterpreted as 100 or 0, and "% of graded questions" quietly changes
meaning across every historical export a coach has already downloaded.

**Recommendation: do not build it.** Not because it is hard to render, but
because it silently redefines "score" for every consumer and changes what old
reports meant.

**The rule to write down now:** if partial credit is ever built, `is_correct`
remains the source of truth for pass/fail and any score is *additive detail*. A
score without a boolean would break every existing consumer.

*(An earlier draft recommended reserving `answers.score SMALLINT NULL` in a
migration that has since shipped without it. Adding a nullable column later is
cheap; the reasoning above is the part that matters.)*

---

## 3. Feedback and undo

`coach_feedback` already exists, is already surfaced to the player, and is
already audited via `GradeAuditLog`. Nothing structural is needed.

**Canned phrases are the one addition worth its weight.** A coach grading forty
drawings will not type forty comments, so most players get nothing. A short,
coach-editable list ("Wrong gap", "Late to fit", "Good leverage") turns
feedback from a typing task into a tap — a small feature with an outsized
effect on whether players receive anything at all.

**Undo:** grading forty items quickly means mis-tapping. `GradeAuditLog`
already records every change including no-ops, so the data exists. An undo
affordance on the last grade in the session would be enough — not a history UI,
just "that was wrong, put it back".

---

## 4. Where "needs review" belongs

Today a coach discovers ungraded work by opening a quiz. That does not scale
past a couple of active quizzes.

**Recommendation:** surface it where the coach already starts — the dashboard —
as a single honest number ("**14 answers waiting for you**") linking into the
queue. Not per-quiz badges scattered across cards; one destination.

**On notifications:** email or push is a larger commitment than it looks
(delivery, preferences, unsubscribes, a sending domain). Defer, and make the
in-app count reliable first. **An unreliable count a coach learns to ignore is
worse than no notification at all.**

**Keep completion and grading visually distinct.** A quiz can be 100% complete
and 0% graded, and a coach must see that at a glance.

### One verification task, unconfirmed

`MANUALLY_GRADED_TYPES` includes `DRAW_RESPONSE`, and `routes/grading.py` and
`routes/players.py` were switched to it — but whether a submitted drawing
actually reaches every awaiting-grading count was **never verified end to end**:
the per-response "N to grade" badge, `_build_dashboard_data`'s question
breakdown, and `/players/history` pending counts. That is a verification task,
not a design question, and it is the first thing any grading work should do.
The counts are how a coach *learns* there is work waiting.

---

## 5. Combined responses — what not to foreclose

`answers.answer_text` and `selected_option_id` are nullable and independent,
and no code assumes a Draw Response lacks them. A question requiring a drawing
*and* an explanation would need two flags
(`requires_explanation`, `requires_choice`) — neither of which exists.

**Where it bites is grading:** two things to judge and one `is_correct`. Either
one judgement for the whole answer (simple, consistent with everything today,
and probably what a coach wants), or per-part judgement — which needs exactly
the partial-credit machinery §2 argues against.

**Recommendation:** design any grading card so the drawing is *one element among
possibly several* rather than the whole card. The review surface shows the
drawing plus, if present, the explanation and the chosen option, and
Correct/Incorrect applies to the answer as a whole. That shape accepts combined
responses without a redesign, and without partial credit.

`is_answered` already asks what the type *requires*, so it gains a conjunction
rather than a rewrite. That is why it was written as a type question rather than
a "has any content" scan.

---

## 6. Open questions

1. **Is grading-by-question right for how you actually work?** §1 assumes a
   coach grades one question across the team rather than one player across
   questions. If that instinct is wrong, the queue is the wrong centrepiece.
2. **Randomised grading order** — a fairness feature, or an annoyance when
   looking for a specific player?
3. **Canned feedback phrases** — worth building, or will you type comments?
4. **Realistic roster size?** The per-question queue argument is strongest at
   40+; at 12 it is still right but far less urgent.
