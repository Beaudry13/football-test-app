# Teach in the meeting room

This covers the teach-room cycle (23 October 2026), on the local branch
`feature/teach-room`, which is not deployed. The goal: a coach stands in front
of his room, teaches the football, checks whether the players know it, and
fixes the miss, all without fighting the software.

## One teaching screen (`components/teach/TeachView.tsx`)

Every entry point uses the same full-screen view: quiz Results, the Rep page,
the quiz editor, a position group's needs, and Motion Lab's *Teach a moment*.

**The football leads.** The picture is sized to the screen. A play picture is
1376×720, and its width follows the height left under the bar, so it never
runs past the bottom of a 16:9 TV. Type scales with the screen (`clamp`/`vw`),
and controls are 44px or larger.

Everything shown is authored. The players, motion, routes and decision
moment, and the ringed man, come from the question or the play as the coach
made them. Nothing is inferred.

**The side column holds the notes:**
- who it is about ("3 of 11 missed it", with names), when the screen knows;
- the concept, when the title doesn't already say it;
- "You're the Boundary safety";
- the question, the right answer, the coach's reason, and what most of the
  room chose;
- *Open the play in Motion Lab*.

**Keys, so it can be run while talking:**

| Key | What it does |
|---|---|
| ← → | Previous / next slide. Past the last slide, → goes to the next thing to teach. |
| 1–9 | Jump to that slide |
| Space | Watch the play again |
| N | Notes on or off (the football alone) |
| A | Ask first, then show the answer |
| F | Browser full screen, for a projector |
| Esc | Close |

**The bar:** the next step (*Retest these N*, *Check them*, *3D*),
*Next: Run fit · 2 missed*, then *Ask first*, *Hide notes*, ⛶ and ×.

**Ask first** is the room check. The play and the question go up, with the
answer held back: no right answer, no reason, no "most chose", no lit spot
and no drawn assignment. When the room has answered aloud, the coach shows it
(A, or *Show the answer*). Each slide starts held back while Ask first is on.
The held-back picture comes from `TeachSlide.pictureAsk`. Nothing is
recorded; Retest remains the formal check.

## Results → Teach → Retest → Next

Quiz Results now runs a single teaching screen (`WeakestConcepts`). It opens
from any concept's *Teach*, or straight from Home through `?teach=`, and shows:
- who missed it;
- *Retest these N*, which builds the existing concept retest and opens it on
  Activate, ready to send;
- *Next*, the next concept the team missed, in the same screen.

A single question's *Teach* on Results also says who missed that question.

In the **quiz editor**, *Teach this* opens on the chosen question, and the
arrows walk through the rest of the quiz's football.

## Rep page

Rep *Teach* says who missed it. *Next* moves to the Rep's next football
problem, which is marked taught exactly as it would be from its own card. The
coach's ring on a still now shows. Once a problem has been retested, the
screen offers *Open retest*.

## Position room

Team → Players → pick a group → *What your safeties need* → **Teach** opens
the teaching screen in place. It shows:
- the football they missed, loaded from the quizzes and Reps where each
  player last missed it (newest first; a retest's copy is shown once);
- who is still working on it;
- *Retest the N*, the same group Rep the panel builds;
- *Next*, the group's next problem.

If no football is available to show there, *Teach* goes to where the players
last missed it instead.

## Motion Lab → Teach

*Teach a moment* starts from what PEIRA already knows:
- the man selected on the field is the man to watch;
- the coaching point is the one the coach wrote for this play, either here or
  as the "why" of a question or Rep made from it (`made-from-play` `last`
  now carries `answer_explanation`);
- the concept he named for the play heads the slide.

It shows the play exactly as it is on screen. Nothing is saved to show it.

On the teaching screen:
- **Check them** (`CheckThem.tsx`) first lists what is already made from the
  play, then offers *Make a rep* or *Make a quiz question*. Choosing one
  gives way to that panel with the same man already chosen. For *Draw his
  job*, his authored route becomes the answer.
- **3D**, where a viewer is configured: the same play through Motion Lab's
  own Preview 3D handoff. *Back to Teach* returns to 2D. 2D remains the
  teaching view, and this adds no second 3D implementation.

3D is offered only in Motion Lab Teach, never on quiz or Rep slides. A
question's picture is its own copy, while the play may have changed since it
was made; showing the play in 3D there would show something the players
never saw.

## Per-coach memory

*Same as last time* on the Activate tab is now kept per signed-in coach
(`auth/useCoachId.ts`, which *Pick up where you left off* also uses). The
old device-wide entry is never read, and is removed on the next send.

## Not built

- Slide authoring or decks.
- A Motion Lab "next play".
- A quiz-level "taught" record, which would need a migration and nothing
  required it yet.
- Room answering on devices.
- Pause or scrub. The play runs to the authored moment and freezes, and
  Space replays it.
