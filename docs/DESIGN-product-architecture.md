# PEIRA product architecture

**Status: APPROVED WORKING ARCHITECTURE, 22 September 2026. Planning only.**

This is the authoritative record of how PEIRA is organised as a product: its
loop, its top-level areas, where Motion Lab and Team live, and the few shared
objects that hold the loop together. When another document disagrees with
this one about *structure*, this one wins.

**Nothing in this document authorises implementation.** It records decisions
so they are not re-argued; each phase in §12 still needs its own approval
before any code, schema or navigation changes. It does not change the
navigation that ships today (Quizzes | Playbooks | Team).

Companion documents, deliberately not duplicated here:

- `docs/DESIGN-game-plan.md` and `docs/SPEC-game-plan-v1.md` — the Game Plan,
  which is the backbone of Teach (§4). Read them for Teach's behaviour and data.
- `docs/MOTION-LAB-BASELINE.md` and the Motion Lab editor specification on
  `feature/motion-lab-p2-library` — Motion Lab itself. Neither is on `master`
  yet; Motion Lab is unmerged and platform-owner only.
- `docs/DESIGN-handoff.md` — the visual redesign brief. Parts of its
  structural list are superseded by this document; see §13.

---

## 1. What PEIRA is

PEIRA is not a quiz app. It is a coaching loop:

**BUILD → TEACH → TEST → COMPETE → UNDERSTAND → RETEACH**

Today's code is strongest at TEST (a mature quiz editor, five question types,
Practice and Graded delivery) and has a working COMPETE (live competition).
UNDERSTAND exists per quiz only. TEACH has no shipped surface: Motion Lab's
Present mode and the Game Plan are the pieces that create it. RETEACH exists
only as re-*testing* (Retest from weak concepts); there is no path from a weak
concept back to the material that teaches it. The architecture below exists to
close that loop without rebuilding what already works.

## 2. Top-level architecture

### Desktop

```
Home | Teach | Test | Results | Library          + New   Team   Help   Account
```

The five areas are jobs, not tools. The global items on the right are
available everywhere.

### Mobile

- Bottom navigation: **Home | Teach | Test | Results | Library**.
- Top bar: **+ New**, **Team** (labelled, not an icon alone), Help, Account.
- Nothing is hidden behind a "More" menu. The same places exist on both form
  factors; only their arrangement changes.
- Each area has a defined phone job rather than a squeezed desktop layout:

| Area | Phone job |
|---|---|
| Home | Who has not submitted, what needs grading, where to go next |
| Teach | Show a player a play on the sideline (read-only board or Present) |
| Test | Send an assignment, share the code, see completion |
| Results | Grade written answers, look up a player |
| Library | Browse and look things up; opening a play offers "view" |
| Team | Look up a player, generate a PIN |

- Authoring is **labelled laptop-first, not hidden**. The Motion Lab editor's
  layout rules start at 1180 px; the competition host screen is built for a
  projector.

### Area highlighting

A destination is highlighted by the job the coach is doing, not by the
component that renders it. Where one screen is reachable from two areas (a
quiz's results, a Concept page), it gets an address in the area that owns the
job, so the highlighted area always matches what the coach came to do. A coach
who lands somewhere with nothing highlighted feels lost.

## 3. Home — the PEIRA portal

Home is not a dashboard. **Home is the PEIRA portal.** Its purpose:

> **"Where do you want to go, and what needs your attention?"**

**The portal is the primary experience.** The top of Home makes the major
PEIRA jobs immediately understandable and reachable:

- **Teach** · **Test** · **Results** · **Library** · **Team**

Each is presented as a job a coach recognises, not a menu label. The portal
repeats the navigation on purpose: the nav is for moving, the portal is for
understanding what PEIRA does and choosing where to start. The portal never
offers an area that has nothing in it — Teach appears when Teach exists.

**Underneath, immediate coaching priorities**, each short and actionable:

- Continue in Motion Lab
- Continue a quiz
- Live assignments and the live competition
- Responses needing grading
- Players who have not submitted
- Teach Next / weak concepts, always with sample sizes
- This Week (Game Plan), once Teach exists

**Home is not** a giant analytics dashboard, the quiz library, a folder tree,
an export page, or roster management. Today's dashboard quiz list moves to
Test (§5). The "at a glance" rail and live sections already on the dashboard
are the natural source of the priorities list.

**Continue.** First version: a per-coach list of recently opened items held on
the device, opening a Motion Lab play in its editor (which already autosaves
and recovers drafts) and a quiz on the tab last used (`?tab=`). Continuity
across devices — build on a laptop, teach from a phone — needs a small
server-side record later.

## 4. Teach

Teach is where coaches show players the football. It has no shipped surface
today, so it enters the navigation only once it has content.

- **Backbone: the Game Plan.** A Week gathers points of emphasis (each linked
  to a Concept), Motion Lab plays by reference, and a Tips document. The Game
  Plan documents define it; this document does not repeat them.
- **Landing:** This Week → Present (this week's and recently presented plays)
  → Teach by concept → Past weeks.
- **Motion Lab Present is Teach's primary tool.** Every play shown in Teach
  offers *Present in Motion Lab*: full screen, Overhead / Coach / Player views,
  telestration. The read-only `OverheadBoard` on the Motion Lab branch was
  built for exactly this kind of use.
- **Concept → material.** A coach reaches the plays and playbook pages that
  teach a concept from Teach by concept, from the Concept page, and from
  Results (§6).

## 5. Test

- **Landing:** Out with players (every active assignment) → Needs grading →
  Quizzes (today's list and folders, unchanged) → Create.
- **Authoring:** the existing full-screen quiz editor.
- **Delivery modes**, presented as three ways to send the *same* quiz:

| Mode | Purpose | Creates today |
|---|---|---|
| **Practice** | Feedback, retries, randomised order | Access code, practice mode |
| **Graded** | One attempt, hand grading, official results | Access code, graded mode |
| **Live Competition** | Projector, timer, leaderboard; outside official results | Competition session |

  Competition is a delivery mode, not a destination: it is launched from a
  quiz, reads that quiz's live questions and writes to its own tables. Mode is
  a property of the assignment, not the quiz — one quiz can go out as Practice
  and later as Graded.
- **Assignments** are access codes (mode, groups, available-until, PINs); only
  their wording changes.
- **Motion Lab in a question**, in two steps: first *Use as visual* — render a
  frame of the play into the question's image, annotatable as today, recording
  which play it came from (planned in the Game Plan design); later an animated
  visual that references the play and pauses at a decision time, mirroring the
  decision point clips already have.

## 6. Results

- **Possible on existing code:** a Results landing listing quizzes with
  results and grading counts; per-quiz results (Teach Next, per-question
  breakdown, grading, exports) at a Results address reusing the existing
  component; player pages; the team PDF.
- **Needs new architecture:** concept mastery across quizzes, player mastery
  over time, group and position views, competition answers in results, and
  question performance across reuse (needs a question bank).
- **Teach Next evolves** from per quiz (today) to per concept across recent
  quizzes to per group and player, then to taught-vs-tested. It always states
  what occurred, with its sample size; it never prescribes.
- **RETEACH:** weak concept → *Reteach* → Teach, with a point of emphasis
  pre-filled and the concept's plays ready to Present. With nothing linked, it
  offers *Build a play for this concept*, which returns to Teach on save.
- **RETEST:** weak concept → *Retest* (the existing concept-based Retest) →
  the new quiz in Test → Deliver → Results shows the existing retest
  verification.

## 7. Library

One Library for reusable football content, instead of today's three separate
collections (quiz folders, the Playbooks list, the Motion Lab Library):

| Category | Status |
|---|---|
| **Motion Lab plays** (with looks) | Built on the unmerged Motion Lab branch. **First and default category.** |
| Playbooks (PDFs and pages) | Built |
| Concepts | Data exists; needs a management screen and a Concept page |
| Teaching materials (Tips documents) | From the Game Plan |
| Question bank | Future |
| Media (images, clips) | Future |

- **One folder system:** the existing `folders` table, split by the `area`
  column the Motion Lab branch introduced (`quizzes` | `motion`, later
  `playbooks`), one tree per category, one shared folder component. Quiz
  folders stay in Test and use the same component.
- **Topic grouping comes from Concept, not folders.**
- The **Concept page** lives in Library; Teach and Results link to it.

## 8. Motion Lab — the hybrid model

Motion Lab is one of PEIRA's defining capabilities. It is prominent without
being a top-level navigation item:

- Motion Lab plays are the **first and default Library category**. Library must
  never open on anything else.
- **+ New leads with "Motion Lab play".**
- Home can prominently surface **Continue in Motion Lab**.
- **Teach prominently uses Motion Lab Present.**
- The full-screen **editor and Present keep Motion Lab branding.**
- Motion Lab is **not a permanent top-level destination for now.**
- **Keep it cheap to add one later.** Motion Lab plays must stay reachable at a
  stable Library address, so a future "Motion Lab" nav item is a pointer to
  that address — not a new area, not a moved feature. Add it only if real
  coach usage shows it is needed.

## 9. Team

Team (Players, Groups, Coaches) is a **labelled global destination**, in the
top bar on desktop and phone. **It is never buried in the account menu.**

Visiting the Team pages is mostly setup — season start, roster changes, PINs,
groups, staff — while Team *data* is used daily inside other work: choosing
players, restricting assignments to groups, generating PINs, choosing a
competition group, opening a player from a response. So Team is always one
labelled tap away, and those in-context uses link into it: every player name
opens one player page, and Deliver and Competition setup offer *Manage groups*.

## 10. Concept — the connective object

Concept is the football object that joins the loop across Motion Lab plays,
teaching, questions, results, reteaching and retesting. It already exists
(`concepts`, organisation-scoped, one per question) and already drives Teach
Next, Retest and retest verification. The architecture extends it rather than
inventing a second vocabulary:

- plays link to concepts (many to many);
- Game Plan points of emphasis link to concepts;
- a concept may optionally sit under a parent (e.g. *Strong Hook* under
  *Cover 3*) so results roll up;
- results and reteaching are read by concept.

## 11. Rules that hold everywhere

### Reference vs snapshot

**Reference shared objects while authoring. Snapshot what the player actually
receives at delivery.** Delivered questions are already frozen as snapshots so
a later edit cannot rewrite what a player saw; shared plays, pages, media and
banked questions must not weaken that.

### Player identity

Historical records identify players partly by name strings (attempts, roster
and group members, competition participants) beside an optional player link.
**Any player-identity migration must classify every historical record as:**

- **unambiguous** — exactly one Player it can belong to;
- **ambiguous** — more than one candidate;
- **unmatched** — no candidate.

**Ambiguous or unmatched history is never silently assigned to a Player
record.** No blind backfill by matching names. Mastery over time, and any
cross-quiz view of a player, **cannot be treated as trustworthy until player
identity has been resolved safely.**

### Descriptive only

Results describe what players did, with sample sizes. They do not prescribe.

## 12. Phased migration (planning only)

**None of these phases is approved to start.** Each needs its own approval.
Nothing is deleted; old addresses redirect; the new structure should be
reversible while it is judged.

0. **Prerequisites:** protect planning documents in git; finish Motion Lab P2
   verification, including its pending manual browser checks; decide how and
   when P2 merges.
1. **Navigation shell:** Quizzes → Test; the dashboard splits into the Home
   portal and Test; Playbooks → Library; Team becomes the labelled global
   item; a Results landing and per-quiz Results address. Teach stays out of
   the navigation until it has content.
2. **Library:** Motion Lab plays as the first category (after P2 merges); the
   Concept management screen and Concept page; the shared folder component.
3. **Teach:** play ↔ concept links; Game Plan V1 in its specified slices;
   Present from Teach. Teach then enters the navigation.
4. **Test:** Deliver with the three modes; Use as visual; quiz from this week.
5. **Results:** safe player-identity resolution (§11); cross-quiz concept
   mastery with competition answers as an option; Reteach and Retest wired end
   to end.
6. **Later:** question bank, media library, animated play questions, season
   and group competitions.

### Minimum structural changes the loop needs

- play ↔ concept link table;
- optional parent on concept;
- question image → source Motion Lab play (provenance only);
- the Game Plan tables, as specified;
- player identity resolved by the three-way rule, and an optional player link
  on competition participants.

Everything else the loop needs exists: questions, concepts, assignments,
attempts, answers, competition sessions, groups, playbook pages. A "result" is
computed from answers and stays that way. The question bank — questions that
live outside a single quiz — is the one large change, and it is deliberately
not in the minimum.

## 13. What this supersedes in `docs/DESIGN-handoff.md`

That brief governed a visual redesign and told it not to change structure.
This document is the structural decision it deferred. **When Phase 1 is
approved**, and not before:

- **Item 9, "the dashboard hierarchy"** — superseded: Home becomes the portal
  (§3) and the quiz list moves to Test.
- **Item 12, "the mobile bottom navigation — three destinations"** —
  superseded: five destinations (§2). Its principle stays: phone only, never
  duplicated in the header.
- **Item 3, "Team → Players / Groups / Coaches as one section with a shell"**
  — the shell stays; its placement moves from primary navigation to the
  labelled global item (§9).
- **"What it is NOT … rename these concepts"** — the renames this document
  records (Quizzes → Test, Playbooks → Library, Activate → Deliver, Roster →
  Players) are architecture decisions, made here, not by a visual pass.

Its other structural items — folder navigation, simplified cards, question
maintenance in `...`, move to position, Code → Available until → Share (now
inside Deliver), the Early Access entry, contextual destructive actions, the
Results hierarchy, Add Question at both ends — are unaffected.
