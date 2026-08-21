# The coach experience at 375px — audit, August 2026

Walked in a real browser against a seeded organization holding a realistic
amount of content: 100 quizzes across 11 folders, quizzes of 3 / 10 / 20
questions, a 53-player roster, 7 groups, 24 submitted attempts on a
20-question graded Peira, and 3 playbooks including a 14-page one.

**Sample data hides most of this.** Four of the six defects fixed below are
invisible with two quizzes and one player, and were only reachable at real
scale.

## How things were measured

Two techniques matter, because both corrected a wrong answer during this
audit:

1. **Hit-testing, not box measuring.** `getBoundingClientRect()` on a folder
   row's `<a>` reports 253×20 and looks like a defect. It is not: the link
   carries `::after { position: absolute; inset: 0 }`, and a hit-test grid
   shows **92% of the 327×61 row taps through to it**. Any "small tap target"
   claim in this document was confirmed by hit-testing from the element's
   centre outwards.
2. **Scroll it into view first.** `document.elementFromPoint` only sees the
   visible viewport, so anything below the fold hit-tests as "nothing here".
   That produced two confidently wrong readings before it was caught.

---

## P0 — prevents completing a task

**None found.** Every audited workflow can be completed on a 375px phone.
The two that came closest are recorded as P1 below (the quiz title field, and
Team → Players scrolling the page) and both are now fixed.

## P1 — the task works but is materially difficult or confusing

### P1-1 — The quiz title was 18 pixels wide *(FIXED — `02e2376`)*
`.titleRow` put the title field and two link-buttons on one flex line. Both
links carry `white-space: nowrap` and refuse to shrink; the input does not, so
it absorbed the whole squeeze. A coach could not read the name of the quiz
they were editing, let alone rename it.

### P1-2 — Team → Players dragged the whole page sideways *(FIXED — `652ad60`)*
The only `nb.table` in the product with no scroll container around it. With 53
players the table was 512px inside a 327px column, so the header, the tabs and
the search box all slid off with the page.

### P1-3 — The quiz editor's tabs scrolled the entire page *(FIXED — `bc19aef`)*
384px of tabs in a 327px strip. Reaching Results meant dragging the editor
left.

### P1-4 — The Help menu opened 99px off the left edge *(FIXED — `c0aef2f`)*

### P1-5 — A playbook's header actions pushed the page off screen *(FIXED — `ae89b02`)*
Worse than it sounds: the thumbnail strip below scrolls horizontally *on
purpose*, so a 14-page playbook had two competing horizontal scrolls stacked
on one screen.

### P1-6 — 16px tap targets on the Activate tab *(FIXED — `5e63d9c`)*
"Change" (the expiry) and "Show QR code" were 16px tall, on the one screen a
coach uses standing on a field with a phone in one hand.

### P1-7 — The dashboard buries the quizzes below the fold — NOT FIXED
At 375px, `Your Quizzes` begins at **y=934**, past the bottom of an 812px
screen. Above it: 189px of navigation, then ~650px of the "Get set up"
checklist. Below the heading, two creation forms (New Quiz, New folder) take
another 175px. **A coach with 100 quizzes scrolls ~1,200px — one and a half
screens — before seeing a single quiz.**

Not fixed because the answer is a product decision: whether a 5-of-7 checklist
should still outrank a coach's actual content, and whether creation forms
belong above the list they add to. Both are Claude Design's call.

### P1-8 — Results shows its exports before any result — NOT FIXED
On the Results tab at 375px the first screen ends on the export buttons
(Detailed PDF / Summary PDF / CSV at y≈770). The scores of 24 players start
below the fold. A coach checking how the team did sees three ways to download
it first.

### P1-9 — "+ Add question" is always past every existing question — NOT FIXED
The only way to add a question sits at the very bottom of the list:

| Questions | "+ Add question" at | Screens to reach it |
|---|---|---|
| 3 | y=1,252 | 1.5 |
| 10 | y=2,813 | 3.5 |
| 20 | y=4,922 | **6.1** |

Building a 20-question install quiz means scrolling the entire quiz between
every question. The fix (a sticky control, a second control at the top, or
both) is a design decision, not a defect with one obvious answer.

### P1-10 — Playbooks put Delete beside the playbook — NOT FIXED
Every playbook row carries a visible `Delete` button 13px below the link that
opens it. Quiz cards moved exactly this pattern into a `...` menu in `146aa65`
for exactly this reason. Applying the same treatment to playbooks is
consistent and cheap, but it is a UI-pattern decision the owner should
confirm rather than something to infer.

## P2 — visual / polish

- **P2-1.** The signed-in header wraps to **5 rows and 189px at 375px**
  (PEIRA / Quizzes·Playbooks·Team / Admin View / Help / Log out) — 23% of a
  phone screen, on every page, before any content. It is 1 row at 640–768 and
  4 rows at 960+.
- **P2-2.** The quiz editor keeps the title field, description field, Preview,
  Start Competition and both tab rows above every tab's content: **~600px of
  an 812px screen is chrome** before the Activate tab shows anything at all.
- **P2-3.** The 40px title type shows roughly eight characters in a 327px
  field. Left alone deliberately — see `02e2376`.
- **P2-4.** `GroupDetailPage` renders no `<h1>`. The group's name is on the
  screen but the document has no heading, so "what screen is this" has no
  semantic answer for a screen reader.

## REDESIGN — for Claude Design, not for patching now

- **R-1.** Mobile navigation. P2-1 and P2-2 are the same problem: Peira has
  no phone navigation pattern, only a desktop header that wraps. This is the
  single highest-value visual-redesign item found.
- **R-2.** Dashboard information order (P1-7).
- **R-3.** Results-tab order (P1-8) and the editor's "add" affordance (P1-9).
- **R-4.** Type scale on phones — the tokens now exist (`24fd48e`); nothing
  consumes them yet.
- **R-5.** Two table designs. Owner uses an always-on `.tableWrap`; coach
  surfaces use `.card:has(.table)` below a breakpoint. Same requirement, two
  mechanisms, different visual results.

---

## Scale findings

### Dashboard
| Quizzes | Result |
|---|---|
| 5 | Comfortable. |
| 20 | Fine; folders keep it short. |
| **100** (30 loose + 70 filed) | **7,270px — 9 phone screens.** No search anywhere on the dashboard. Folders behave well (10 rows, 61px each, whole row tappable). |

The failure mode is *unfiled* quizzes: filing works, and 70 quizzes behind 11
folders cost 10 rows. 30 unfiled quizzes cost 30 cards. Peira currently has no
way to find a quiz except to recognise it while scrolling. **Search is on the
do-not-start list, so this is recorded, not built.**

### Quiz editor
3 → 1.7 screens, 10 → 3.6, 20 → 6.2. Linear and honest; the editor never
overflows horizontally at any count. The cost is entirely P1-9.

### Team / Players
8 players fine. **53 players — a real football roster — was the P1-2 defect.**
Now scrolls inside its own container. 55 selection checkboxes are 13×13px
each, but each is wrapped in a `<label>`, so the effective target is larger;
no hit-test failure was demonstrated, and this is left for the redesign rather
than asserted as a defect.

### Groups
7 groups, 8 players each: 2.3 screens, no overflow. Group detail inherits the
same checkbox pattern as the roster.

### Results
24 submitted attempts on a 20-question quiz: **6.9 screens**, no horizontal
overflow — the results table correctly scrolls inside its card. The order
problem (P1-8) is what makes it feel long, not the height.

### Playbooks
3 playbooks list in one screen. The 14-page playbook was the P1-5 defect. Its
thumbnail strip scrolls horizontally by design and does so correctly once the
header stopped fighting it.

---

## What was verified working

- **The player experience at 375px is clean.** Join → roster select → question
  → drawing board: no horizontal overflow at any step, and **no tap target
  under 40px anywhere in it**. It is the most phone-ready surface in Peira,
  which is what you would hope for.
- Quiz preview: one screen, no overflow.
- Early Access, Request Access, Login: one screen each, no overflow.
- Folder pages, player profile, group list: no overflow.
- Question create and edit forms: no overflow at 375px.
- Team → Coaches: the table overflows its card and the **card** scrolls — the
  intended behaviour, and the model the roster page was missing.

## Not audited

- **Competition** — deliberately excluded; it is a projector stage with its
  own environment.
- **Keyboard-open layout behaviour.** A software keyboard cannot be simulated
  in this browser, and `visualViewport` behaviour differs enough between iOS
  and Android that a desktop emulation would be a guess. Recorded as untested
  rather than reported as passing.
- **Annotation and masking editors** were not driven end to end; they need a
  real uploaded image, which would mean writing files into local storage.
