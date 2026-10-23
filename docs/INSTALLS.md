# Installs

This covers the installs cycle (23 October 2026), on the local branch
`feature/installs`, which is not deployed. The goal: PEIRA stops being a pile
of good features and becomes the place a coach organizes, teaches, tests and
fixes this week's football.

## What an install is

An install is a name ("Week 7 - Central", "Spring install 4", "Safeties -
Week 7") and an ordered list of football the coach already has:

- **plays** (Motion Lab plays; only for coaches who can open Motion Lab);
- **quizzes**;
- **Reps** (a Rep is a quiz with kind REP, so it is a quiz item);
- **concepts**.

It can have **one level of sections** ("Base", "Third down"). There are no
nested folders and no playbook tree. It can optionally be **for a position
room**, keyed by the roster's position families (`family:Safeties`). That one
choice makes a concept say "3 of 4 safeties still missing it", and makes the
meeting's retest go to exactly them.

"Install" is the only term used for it, in the UI and in the code.

## References, never copies

An install item is a reference: `kind` plus one of `motion_play_id`,
`quiz_id` or `concept_id`, with a check constraint that exactly one is set.
Nothing is copied into an install.

- Taking an item out, or deleting the install, leaves the football where it
  was.
- Deleting the football removes its items (`ON DELETE CASCADE`). An install
  never holds a dead link.
- A play is shown **as Motion Lab holds it now**. Motion Lab is the source of
  truth for authored football.
- A quiz or Rep is shown as **the quiz itself**. A delivered quiz keeps its
  own snapshots (copied questions, presnap stills), exactly as before. Adding
  it to an install changes nothing about it, and no player's answers or
  results are touched.
- **Duplicate for a new week** copies the name, the sections and the
  references, never the football. The new week's install points at the same
  plays, quizzes, Reps and concepts.

## Schema (migration `a7d4e2c19b63`, additive)

Three new tables:

| Table | Columns |
|---|---|
| `installs` | `organization_id`, `coach_id`, `title`, `position_group` (nullable), `archived_at` (nullable), timestamps |
| `install_sections` | `install_id`, `title`, `position` |
| `install_items` | `install_id`, `section_id` (nullable, `SET NULL`), `position`, `kind`, and one reference |

Each reference is unique per install. Downgrade drops the three tables.
`installs` is listed in the organization-merge table set.

The chain is `d7f3b1c58e29` (production) → `e4b9d2a6c815` → `b6e2d8f41a07`
→ `a7d4e2c19b63`.

## API (`/api/installs`, own installs only)

| Route | What it does |
|---|---|
| `GET /installs` (`?archived=1`) | Active installs, the most recently worked on first; or the archived ones |
| `POST /installs` | Create: title, optional `position_group` |
| `GET /installs/for?kind=&ref_id=` | Active installs, each with whether it already holds this football (for *Add to install*) |
| `GET / PATCH / DELETE /installs/<id>` | Detail; rename, set who it is for, archive or restore; delete |
| `POST /installs/<id>/items` | Add by reference. Validated (a play needs Motion Lab access and the org's play; a quiz must be visible to the coach; a concept must be the org's). Adding the same football twice is a no-op |
| `DELETE /installs/<id>/items/<item>` | Take it out |
| `PUT /installs/<id>/layout` | The whole order: loose items, then sections with their items. Every item placed exactly once (else 422). Sections left out are removed; new ones are created |
| `POST /installs/<id>/duplicate` | Same sections and references, new name |

The detail payload gives each item **what PEIRA already knows**. Nothing is
scored or guessed.

- **play**: how many quizzes and Reps were made from it.
- **quiz**: whether it is out, how many turned in, how many answers are
  waiting to be graded, and its weakest concept (missed / responded).
- **Rep**: whether it is out, how many ran it of how many invited, and its
  open football problem (first-try rules), including whether it was taught.
- **concept**: how many quizzes and Reps it is in.

The position room's "N still missing it" comes from the existing
`/players/needs`.

## Screens

**Installs (`/installs`).** "This week" first, then the rest in the order
they were last worked on. Archived installs sit behind "Archived (n)" with
Restore. A new install is a name and, if the roster has positions, who it is
for. There is no navigation item: the way in is Home's cue and every *Add to
install*.

**An install (`/installs/:id`).**
- One primary action: **Teach install**.
- **Add football** opens a finder over the lists PEIRA already loads: Recent,
  Plays, Reps, Quizzes, Concepts, plus a search box. What is already in the
  install says "✓ Added".
- Each row shows the kind (a coloured tag), the name (opens where it lives)
  and the one line of what PEIRA knows, with anything needing the coach in
  gold.
- Each row's actions: **Teach** (the meeting starts at that row), **↑ ↓**
  (40px, so a phone can order it) and **More** (open it, Results, move to a
  section, take out).
- The install's More menu: Rename, Add a section, Who it's for…, Duplicate
  for a new week, Archive or Restore, Delete. A section's More menu: Rename,
  Move up or down, Remove the section (its football stays in the install).

**Add to install, from where the football is.**
- In Motion Lab, *Use this play → Add to install* (saved plays only).
- Beside *Make a variation* on a Rep.
- With *Preview as player* in the quiz editor.
- In a concept's details on Results.

The panel lists active installs (✓ where it is already in), adds with one
tap, and starts a new install on the spot.

**Home.** One quiet line: "This week: Week 7 - Central · 2 plays · 1 Rep ·
Teach". It shows the install the coach last worked on. Without one, Home
keeps its "Pick up where you left off" line, so there is never more than one
continuation cue.

## Teach install

The meeting is the existing Teach screen (`TeachView`). The install only
decides what comes next.

- **A play**: its motion to the snap, then the play with its authored routes.
  Ask first holds the routes and the coach's point back. The play also shows
  the man and the point from what was last made from it, plus **Check them**:
  what is made from it already, or make it in Motion Lab with the man chosen
  (`/motion-lab/plays/<id>?make=rep|question&man=<id>`).
- **A quiz**: its football with what the room chose, and **Retest** the
  weakest concept for exactly who missed it.
- **A Rep**: its open football problem ("3 of 9 missed Motion adjustment",
  with names), and **Retest the 3 who missed** (or *Open retest* when one
  exists).
- **A concept**: in a position room's install, the football that room missed
  and **Retest the N**. Otherwise, the coach's football on that concept, each
  piece once, identified by source question rather than wording.

**Next** goes to the next item (→ past the last slide too), and the item after
it is fetched while this one is taught. **Back** (‹, or ← before the first
slide) returns. An item with nothing to show is passed over in either
direction. The bar says where the meeting is ("Week 7 - Central · 2 of 4").
Ask first stays on from item to item. Notes, full screen and the keys work as
everywhere else. Retest leaves the meeting for the retest's send screen, as it
does everywhere else.

One Teach rule changed for every Teach screen: a slide with no question (a
play from Motion Lab) carries the coach's point as its words, and **Ask first
now holds that point back** until *Show the answer*.

## Position coaches

A safeties coach makes "Safeties - Week 7" for Safeties and adds the
concepts, Reps and plays for his room. The install page then says, per
concept, how many of his safeties still miss it. Teach install walks it, the
room line names who, and **Retest the 3** builds one Rep of the football they
missed, for exactly them, and opens it to send. This is the same builder as
the roster's "What your safeties need".

## Not built

- Drag-and-drop ordering (arrows instead: reliable on touch, keyboard and
  screen readers).
- Nested folders, a playbook system, calendar, practice scripts, scouting,
  game-plan or season analytics.
- Badges, streaks, rankings, sharing.
- Permissions beyond "your own installs".
- Player-facing installs.
- A navigation item.
