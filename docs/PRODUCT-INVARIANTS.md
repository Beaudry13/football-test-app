# Product invariants

The rules PEIRA cannot casually break. Each one is deliberate. Changing one is
a product decision, not a refactor; ask the owner first. The detail lives in
the linked docs.

## Football truth

1. **Motion Lab authored football is the source of truth.** Players,
   alignment, motion, routes, timing, the ringed man and the snap come from the
   play as the coach drew it. Nothing reads a play and decides what it "means".
2. **Coach judgment overrides inferred meaning.** Never infer assignment,
   coverage, route intent, motion intent, stance, leverage or player
   responsibility. "You're the boundary safety", the right answer and the
   reason are the coach's words. A prefill from what he wrote before is a
   suggestion he can change, never a decision made for him.
3. **3D visualizes authored Motion Lab football.** Preview 3D renders the play
   document; it adds no football. 2D stays the primary teaching picture.
   ([MOTION-LAB-3D-PRODUCTION](MOTION-LAB-3D-PRODUCTION.md))

## What players were asked

4. **Delivered assessments preserve their snapshots.** Once an attempt starts,
   the player's questions, pictures and answers stay what he was asked.
   Editing a quiz or a Motion Lab play later never rewrites a delivered
   question or a result.
   ([DESIGN-delivered-question-snapshots](DESIGN-delivered-question-snapshots.md))
5. **A retest copies the questions it retests.** A retest's questions are
   copies that point back at their source (`copied_from_question_id`). They
   are the same football, identified by source, never by wording.

## What a player sees after answering

6. **Reveal rules by kind of work:**
   - **Rep:** after he locks an answer, he may see the right answer and the
     coach's reason.
   - **Practice quiz:** keeps its current behavior. Don't add reveals.
   - **Graded quiz:** never shows the coach's explanation automatically and
     carries no per-option correctness. There is no player-side retry of a
     graded quiz. Assessment stays assessment; reteaching goes through Teach,
     a Rep or a retest.
   ([PLAYER-HOME](PLAYER-HOME.md))
7. **A retry never changes the original attempt.** *Try the misses again* is a
   new practice attempt (Reps and practice quizzes only). The original run,
   its score and every run-level reading stay as they were. A retry is not an
   official result.
8. **Drawing answers are graded by the coach.** There is no automatic grading
   of a drawing, and no AI football judgment anywhere.

## Teaching

9. **Teach is a way of showing football, not another assessment engine.** The
   one Teach screen (`TeachView`) shows existing questions, Rep decisions and
   plays. It records nothing about players. Checking understanding means
   making or sending a real quiz or Rep through the normal flow.
10. **Ask first holds the answer back.** That covers the right answer, the
    reason, the lit spot, the drawn assignment, a play's routes, and, on a
    slide with no question, the coach's point. All of it waits until *Show
    the answer*.

## Organizing

11. **An install refers to football; it never copies it.** Items are
    references. Removing an item or deleting an install touches no football.
    Deleting football removes its items. *Duplicate for a new week* copies
    the order and the references only. ([INSTALLS](INSTALLS.md))
12. **The current install is explicit.** It is set by the coach, at most one,
    and cleared by archiving or deleting it. It is never inferred from
    editing, opening or teaching.

## Surfaces

13. **Player screens stay the simplest screens in PEIRA.** There is one next
    thing to do, in player words, with no coach terminology (concept,
    retest, assessment) and tap targets of 44px or more.
14. **Home stays quiet.** It answers three questions: what needs me, what I
    was working on, and what's next. It has one continuation line (the
    current install, otherwise *Pick up where you left off*). No new cards,
    no dashboard.
15. **Gold means "probably what you do next".** Each screen has at most one
    gold (primary) action at a time. Everything else is quieter, and rare
    actions go behind More.
16. **Same action, same words.** See [TERMINOLOGY](TERMINOLOGY.md).
