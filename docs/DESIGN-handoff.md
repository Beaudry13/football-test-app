# Claude Design — handoff

The structural UX phase is complete. This is the brief; the two companion
documents are the map and the constraints.

- `docs/DESIGN-implementation-map.md` — every surface: route, component, CSS
  modules, primitives, tests, what must not change.
- `docs/DESIGN-light-theme-migration.md` — what changing the colour actually
  costs, measured.
- `docs/DESIGN-landing-page-assets.md` — the asset plan behind the story below.
- `docs/AUDIT-375-coach-workflows.md` — what a phone actually looked like, and
  what is deliberately still open.

## Direction

- The coach experience moves to the warm **light** Peira visual family.
- **Editorial, not analytics dashboard.** The interface frames the content and
  gets out of the way.
- **Film, playbook pages, diagrams, questions and results are the heroes.**
- **Keep Peira gold.** If it fails on warm neutral, change *where and how* gold
  is used before changing the colour.
- **No team colours as application chrome.**
- **Player and coach should feel like the same product.** The player UI is
  already light and already the most phone-ready surface in Peira — it is the
  reference, not the work.
- **Competition stays dark and separate.** Verified structural: `pages/compete/`
  reads zero `--peira-*`, `--nb-*` or `--color-*` tokens and lives outside
  `NotebookLayout`. A token change cannot reach it.
- **Design mobile-first at 375px.**
- **One obvious primary action per screen** where possible.
- **Preserve all existing functionality and information** unless explicitly
  approved otherwise.
- The image **lightbox keeps a dark scrim** — the app can be light while film
  is viewed against dark.

## The structure the redesign builds on — do not undo

Each of these was a decision, most of them measured, and several exist because
the alternative was tried and failed:

1. **Folder navigation.** Folders are places to go, not things to unfold.
2. **Simplified quiz cards**, with maintenance behind `...`.
3. **Team → Players / Groups / Coaches** as one section with a shell.
4. **Question maintenance inside `...`.**
5. **Move to position** — no drag-and-drop.
6. **Code → Available until → Share** on the Activate tab.
7. **Early Access entry** — invite and request are structurally different.
8. **Contextual destructive actions**, everywhere: quiz cards, folder rows,
   question rows, playbook rows.
9. **The dashboard hierarchy** — a coach's own work before the setup checklist,
   creation one tap from the top rather than two permanent forms.
10. **The Results hierarchy** — the answer before the download.
11. **Add Question at both ends of the list**, with the form at the bottom
    because that is where a new question lands.
12. **The mobile bottom navigation** — three destinations, phone only, never
    duplicated in the header.

Two load-bearing details that look like styling and are not:

- **`FolderRow` and the playbook row use `::after { inset: 0 }`** to make the
  whole row the tap target. Removing it drops a 327×61 target to 253×20.
- **`MenuButton` is `position: fixed` and clamped on both axes.** It is fixed
  to escape `.card`'s `overflow: hidden`, and clamped because it opened 87px
  off the left and 154px below the bottom of a phone. Do not make it
  `absolute` again, and do not remove the clamps.

## What the redesign IS

Colours, typography, spacing, visual hierarchy, surfaces, image presentation,
responsive polish.

## What it is NOT

Permission to reinvent Peira's functionality, re-order these screens, rename
these concepts, or "unify" things that are deliberately separate — the coach
and player *themes* converge; the coach and Competition themes do not.

## Known-open, deliberately

These are recorded rather than fixed, and several are the redesign's to solve:

- The per-question breakdown is 1,948px on a 20-question quiz, which is what
  pushes the Results exports 3.6 screens down. A denser breakdown fixes it.
- The 40px quiz-title type shows about eight characters in a 327px field.
- `GroupDetailPage` renders no `<h1>`.
- Owner tables and coach tables solve horizontal overflow by two different
  mechanisms and look different as a result.
- The dashboard has no search. 30 unfiled quizzes is 9 phone screens. **Search
  is explicitly not approved** — do not add it as part of a visual pass.

## The landing page — a 30-second story, shown not explained

One play, followed end to end. Cover 3 is the recommended play: legible to a
non-coach, one right answer, a real install-week question.

**1. Playbook → question.** A real playbook page with an assignment masked, and
the question built from it.
> *Build quizzes from the playbook you already use.*

**2. Player answers.** A phone showing the question, or the drawing answer —
the thing no other quiz tool does.
> *Players answer on their phone in two minutes.*

**3. Coach sees results.** Real results: the per-question line is the sharpest
frame, because it answers "what do we re-install on Tuesday?"
> *See who knows it before you're on the field.*

**4. Only if it helps.** The activated quiz card — code, Available until,
Share.
> *Send it in the group text.*

**Show the product instead of explaining it in paragraphs.**

**Do not invent testimonials, customer counts, logos, statistics or social
proof.** Peira is in Early Access; the honest story is what the product does.

Two practical notes from the asset plan: the player beat can be a **live
component** because that UI already looks right, and the other three should be
composed — each carries either chrome the story does not need or a known
layout issue. Only one asset cannot come from the product itself: a
**purpose-drawn playbook page**. Use a fake access code in any Share artwork.
