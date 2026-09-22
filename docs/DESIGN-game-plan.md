# Game Plan: product definition (refined)

Status: DIRECTION APPROVED IN PRINCIPLE, refined 19 September 2026.
**Nothing is implemented. No migrations. No changes to Motion Lab, Quizzes,
Results or Competition.** This version supersedes the discovery draft of
the same date; the discovery reasoning (three models, why the board with a
concept spine won) is kept in §19 for the record.

Companion wireframes: `docs/game-plan-wireframes.html` (published as the
"Game Plan Week" artifact): landing, week page, Tips & Reminders builder,
quiz builder panel, Home card, phone entry.

Correction to the discovery inventory: Motion Lab P2 exists on an isolated
branch with server persistence, organization-owned plays, a Library with
folders, optimistic revision conflicts, server autosave and collaboration
semantics. It is not deployed. **This design treats the Motion Lab Library
as an upstream capability that reaches PEIRA before Game Plan V1, and
references its records. Game Plan stores no plays.**

---

## 1. Final product definition

**Game Plan is the week's shelf.** For a period of preparation (a game
week, a camp week, a bye) it holds the opponent, what they do, what we must
know, and the material used to teach it, so that the Friday study sheet
and the Saturday quiz are assembled from that material instead of built
from nothing.

It is not project management, a calendar, a task tracker, a scouting
database, or a replacement for Motion Lab or Quiz. Inside a week there are
no statuses a coach types, no owners, no due dates, no checklists. The only
"progress" is derived: whether Tips & Reminders exist, whether a quiz is
linked.

What it adds to PEIRA that nothing else provides: **a record of teaching
intent** (points of emphasis) between a Motion Lab play and a quiz
question, kept in the coach's own weekly language and tied to the durable
Concept so that, six weeks later, PEIRA still knows the questions were
about Mesh.

Principles (unchanged): create once, teach with it everywhere; reference,
never copy; optional everywhere (Motion Lab, Quiz, Playbooks work exactly
as today without a week); football words in the coach's order; the
material is the hero; V1 small.

## 2. Concept ↔ Point of emphasis model

**Concept** stays exactly what it is: PEIRA's durable, org-scoped, flat
taxonomy of football knowledge, tagged on questions, driving "Teach next",
Retest and the delivered snapshot. Examples: Mesh, Counter, Cover 3 Strong
Hook, Empty Protection. Not renamed, not moved, not duplicated.

**Point of emphasis** is *a weekly wrapper around an optional Concept*:

```
Point of emphasis (belongs to one week)
  title        "Mesh: cut crossers, communicate bunch release"   the coach's words this week
  emphasis     "Our call: Push · Cone"                            one optional line
  concept  →   Mesh                                               optional reference to an existing Concept
  order
  items    →   the material that teaches it (plays, notes)
```

Rules that keep it one taxonomy, not two:
- A point's title is free text and is never written to the Concept list.
  Titles are weekly headings; they die with the week (or travel with
  "Start from", V1.1).
- A point's `concept` is chosen with the **same control the question editor
  already uses** (pick from the org list, or "New" to create one). Creating
  a concept from a point is the *only* way Game Plan touches the concept
  list, and it is the coach choosing to.
- Two points in one week may reference the same concept ("Mesh: bunch
  release communication" and "Red-zone Mesh leverage" both → Mesh). Many
  weeks may reference the same concept. A concept has no knowledge of
  weeks; the join is one-directional and cheap.
- Questions keep exactly one tag, `concept_id`, as today. When a coach uses
  a point from the quiz builder's "From this week" panel (§8), the question's
  Concept is set to the point's concept automatically. No second field on
  Question in V1.
- A point with no concept is allowed. It is a heading for material that is
  not knowledge to be tested ("Special teams reminders"). The point shows a
  quiet "No concept" note, and the coverage line (V1.1) says it cannot be
  measured. Nothing nags.
- Long-term intelligence: every question written from a week's point
  carries the durable concept; the existing concept services (weakest
  concept, who missed it, retest, verification) work unchanged, and a future
  concept page can list "taught as a point in Week 4 (Miami), Week 9
  (Toledo)" by a join on `point.concept_id`.

Rejected alternatives: *a concept placed into a week* (no weekly language,
cannot have two points on one concept); *a point that is its own concept*
(the discovery draft; it would grow the concept list with weekly phrasing
and merge unrelated weeks under one name); *a second tag on questions*
(`point_id`) for exact per-point coverage. The last is the only one worth
revisiting: it is additive, and V1.1 may add it if two points on one
concept in one week turns out to be common.

## 3. Minimum week model

```
Week
  label      "Week 4"        free text, required, shown after the opponent; the coach's calendar words
  opponent   "Miami (OH)"    free text, optional
  date       2026-09-26      date only, optional; the game / scrimmage / end of the period
  org, created_by, created_at, updated_at
```

That is the whole object. Cut, with reasons:
- **Season**: derived. Weeks group by the year of `date` (or of `created_at`
  when no date). A spring season, a 7v7 summer and the fall all sort
  correctly by date inside the year. A `season` field returns only if a
  program runs two seasons that must be listed apart within one year, which
  the label already handles ("Spring 3").
- **Week number**: it is the label. "Week 4", "Camp 2", "Bye", "Playoff R1",
  "Spring 3", "7v7 · Jun 14" are all labels. Numbering is not derived, because
  bye weeks, camp weeks and postseason make derived numbers wrong more often
  than right.
- **Kind** (game / bye / camp): derived from what is filled in. No opponent
  and no date is a bye or camp; the coach's label says which. Nothing in the
  UI branches on kind.
- **Home / away**: cut. Type "at Miami (OH)" in the opponent if it matters
  for the sheet.
- **Status**: derived. *Current* = the week whose date is the nearest on or
  after today, else the most recently updated week with no date; *upcoming*
  and *past* by date. There is no archived, done or locked.
- **Notes**: cut. A week-level thought is a Note item in Scouting.
- **Opponent twice**: two weeks, two labels, two dates. "Start from" (V1.1)
  copies references from the earlier one. The future Opponent record (Later)
  is a name match on `opponent`, so nothing is lost by using text now.

**Is "week" the right product term?** Internally the object is a *plan
period*; the coach never sees that phrase. "Week" is how coaches talk about
every period they prepare for, including "camp week" and "bye week", and
the free label absorbs the non-weekly cases. UI term and product term are
both "week"; the section is "Game Plan"; the record can be named
`game_plan_week` without confusion.

## 4. Final week page

One page, two sections, one header. Not four dashboard panels.

```
← Game Plan
MIAMI (OH)                                                        [Tips & Reminders: Draft ▸]  [Quiz: Not started ▸]   ···
Week 4 · Sat Sep 26

SCOUTING · what they do                                                                           [Add ▾]
  ┌ Trips Rt — Mesh ┐  ┌ Jet motion → Toss ┐  ┌ 3rd down tendencies ┐
  │   snapshot      │  │   snapshot        │  │ 3rd & 4–6: 71% pass, │
  │ 3 answers       │  │ 1 answer          │  │ 80% from empty …     │
  │  · vs Cover 7   │  └───────────────────┘  └──────────────────────┘
  │  · vs Cover 3   │
  │  · vs Pressure  │
  └─────────────────┘

POINTS OF EMPHASIS · what we must know                                                [+ Point of emphasis]
  1  Mesh: cut crossers, communicate bunch release           Mesh                 3 plays · 2 notes
     Our call: Push · Cone
     [Mesh vs Cover 7] [Mesh vs Cover 3] [Mesh vs Pressure] "Nickel: #2 vertical = carry" "Corner: settle on 3 flat"   [Add ▾]
  2  Jet motion: Toss fits                                   Toss                 1 play
     Our call: Spill · force by Will
  3  Red zone: Cover 2 invert                                Cover 2              1 note
```

- **Header** carries the two outputs as chips with a state word and an
  arrow: *Tips & Reminders: Not started / Draft / Exported Fri 4:12 pm* and
  *Quiz: Not started / Draft / Out with players / Results*. Clicking a chip
  opens or creates the output. That is the "what's ready for Friday /
  Saturday" answer, and it costs one line.
- **Scouting** is the material not attached to a point: opponent plays with
  their answers nested, and notes. It is the "what they do" answer.
- **Points of emphasis** is the "what we must know" answer, and each point's
  material *inline* is the "what I'm teaching with" answer. No separate
  material section.
- **One gold action** on the page, chosen by state: `+ Point of emphasis`
  when there are none; the Tips chip when points exist and tips do not; the
  Quiz chip when tips exist and no quiz is linked. Never a gate, only the
  most likely next thing.
- **Add ▾** (same menu in Scouting and in every point): *From Motion Lab*
  (library picker, multi-select), *New play in Motion Lab*, *Note*. A point's
  menu also has *Add from Scouting* (choose existing items; the item moves
  to the point).
- **Card / item menu**: Open (plays) · Add an answer (source plays) · Move
  to point… / Move to Scouting · Edit caption · Remove.
- Points reorder with the existing "Move to position" pattern; no
  drag-and-drop, matching the rest of PEIRA.
- Desktop and tablet first. Phone rendering in §10.

## 5. Final item types

Two kinds in V1, one generic record:

```
Item (belongs to one week; optionally to one point; ordered)
  kind        play | note
  play_id     Motion Lab play (kind = play)          reference, never a copy
  source_play_id   the Motion Lab play this is an answer to (kind = play, optional)
  text        (kind = note)  title + short text, plain
  caption     one line, optional (plays); printed under the picture in Tips
```

Why only these two:
- **Play** is the material Motion Lab makes and the reason Game Plan is
  worth building: opponent plays, answers, our concepts, all as references
  to the Library. The card shows the Library's snapshot.
- **Note** is the reminder, the tendency, the call, the "3rd & 4–6: 71%
  pass". It is the Tuesday-through-Thursday material and the bulk of every
  Friday sheet.

Cut from V1, with reasons:
- **Page (playbook page reference).** A page is a page of an uploaded
  playbook PDF, the org's only shared document material. It is real
  teaching material, but it overlaps with Tips & Reminders (where a page can
  be added at build time, V1.1) and with Quiz (where "Choose from Playbook"
  already exists). The week does not need it to establish the model. V1.1.
- **Image.** Would introduce an org-scoped reusable image where PEIRA has
  only single-owner question images. Real value for film stills; not needed
  to prove the model. V1.1.
- **Labels** (Run / Pass / Tendency / …) and **unit** (Offense / Defense /
  ST). Organization affordances that a first version does not need; the
  card and the point title carry the meaning. V1.1.
- **Question, Clip, Look.** Later.

## 6. Motion Lab source / answer model

Built on the Library's existing duplication; no live inheritance.

| Question | Answer |
|---|---|
| What remains the source | The original Library play ("Trips Rt — Mesh"), untouched. Its item in Scouting is the source card. |
| What gets duplicated | The whole play, through the Library's own duplicate operation, named `"<source name> vs <answer name>"`, in the same Library folder as the source. Game Plan asks Motion Lab to duplicate; it does not copy play JSON itself. |
| Where the answer lives | In the Motion Lab Library as an ordinary play (openable, editable, deletable there), and in the week as a Play item with `source_play_id = source`. |
| How it is shown | Nested under the source card in Scouting ("3 answers · vs Cover 7 · vs Cover 3 · vs Pressure"), and as an ordinary play card wherever it is placed (typically inside a point). The nesting is a display grouping, not a separate object. |
| Source edited later | Nothing happens to answers. The source card says nothing about it. If the coach wants the new offense under a defense, they add another answer. |
| Answer edited | Nothing happens to the source or to other answers. |
| Source removed from the week | Answers stay as ordinary Play items; the grouping disappears. The Library play is untouched. |
| Source deleted in the Library | The source item shows "Play removed" with its last snapshot; answers are unaffected (they are their own plays). |
| Does Game Plan persist the relationship | Yes, minimally: `source_play_id` on the answer item. It is one nullable reference, it is what makes the nesting possible, and it survives the source being removed from the week (the answers simply un-nest). No Motion Lab schema is touched. If the Library's duplicate already records `duplicated_from`, Game Plan may read it instead, but should not depend on it. |

Flow: source card › **Add an answer** › one field, the answer name ("vs
Cover 7"), Enter › Motion Lab opens the new play (the offense is already
there) › the coach draws the defense › Motion Lab's server autosave keeps
it › the coach returns to the week (a "Back to Miami (OH) · Week 4" link in
Motion Lab's header while opened from a week). Three actions per answer.

## 7. Tips & Reminders V1

The Friday deliverable, assembled from the week in minutes, exported to
PDF. Not a document designer.

**Document = an ordered list of blocks, three kinds:**
- `heading` (text)
- `text` (a short paragraph or bullet list; plain)
- `picture` (a Motion Lab play by reference, with a caption)

There is no "point" block. Adding a point *expands* into blocks: a heading
(the point's title), a text block ("Our call: …") if the emphasis line is
set, its notes as text blocks, its plays as picture blocks. Once added, the
blocks are the document's own; editing a block never changes the week.

**The builder:**
- Left: **Add from this week** — the week's points (each with a single
  *Add point* action and, beneath it, its plays and notes each with *Add*),
  then Scouting items each with *Add*. Items already in the document show a
  check instead of *Add*. Below: *Add heading*, *Add text*.
- Right: the document, rendered as it will print (light theme, PEIRA
  header block: TIPS & REMINDERS / opponent / label · date). Every block has
  up / down / remove; heading and text blocks edit inline; pictures take a
  caption.
- Top: **Export PDF** (primary), **Preview** (opens the PDF in a tab). No
  fonts, colors, columns, templates or themes.

**Layout is decided by the template, not the coach:** letter, PEIRA header,
headings as section rules, text full width, consecutive pictures in a
two-column grid, page numbers, the week in the footer. Playfair for the
opponent and headings, Inter for text, one gold rule. Built with the
existing ReportLab pipeline and theme dict. Play pictures are the Library
snapshots at print resolution.

**States:** *Not started* (chip on the week; clicking creates the document
prefilled with every point, in order, and nothing from Scouting) · *Draft* ·
*Exported <time>* (a new export overwrites; the PDF is the coach's file).
"Prefilled with every point" means a coach who wants the whole week presses
Export once; a coach who wants a subset removes blocks. Both are under a
minute.

**Digital later:** the block list is the delivery format. Player delivery
(Later) renders the same blocks inside the existing access-code flow with
signed media, and records who opened it. Nothing in V1 prevents that.

## 8. Quiz "From this week"

Quiz stays independent; a week makes authoring faster; nothing becomes a
question automatically.

**Linking.** `week_id`, nullable, on Quiz. Set by: the week's *Quiz* chip
(*Build the quiz* creates a quiz titled "Miami (OH) · Week 4" in the coach's
current folder and opens it; *Link an existing quiz* picks one). The quiz
editor shows a "Miami (OH) · Week 4" chip beside the title with a back link;
the quiz's `…` menu offers *Unlink from week*. Retest drafts inherit the
parent's week.

**The panel** (question editor, right side, only when the quiz has a week,
collapsible, collapsed by default on phones):

| In the panel | Action | What happens |
|---|---|---|
| A point of emphasis (title, concept name) | **Use concept** | Sets the question's Concept field to the point's concept. Disabled with "No concept" when the point has none. |
| A play under a point | **Use as visual** | The play's Library snapshot becomes the question's uploaded image (a copy, so the single-owner rule holds), and, if the point has a concept and the Concept field is empty, sets it. The image is annotatable as any upload. |
| A play in Scouting | **Use as visual** | Same, no concept. |
| A note | *(no action; shown as reference text with Copy)* | Notes are teaching language, not questions. The coach reads it and writes the question. |

Nothing else appears. No "Generate question", no "Ask about this" that
invents prompts, no quiz-side view of the whole week.

**Concept field** in the question editor: when the quiz has a week, the
week's concepts are listed first under "This week", then the rest. The
field itself is unchanged.

**Coverage** ("8 questions · concepts covered: Mesh, Toss · not yet: Cover
2") on the week's Quiz chip is V1.1: it is one join on concept, but it is
not needed to establish the model.

**Future, not V1:** a fourth visual source, "Motion Lab play", that
references the play and animates in the quiz. That is a Quiz feature; the
panel's *Use as visual* becomes a one-line change when it exists.

## 9. Home connection

One component, only when a current week exists, placed at the top of the
dashboard's main column above "Live now":

```
THIS WEEK
Miami (OH)
Week 4 · Sat Sep 26
Last: "Mesh: cut crossers…" edited Thu 9:40 pm
Tips & Reminders: Draft · Quiz: Not started
                                             [Continue Game Plan]
```

Why not counts: "3 points · 6 items" tells a coach nothing they will act on
and drifts toward vanity. Home should answer *where did I leave off*, so the
card shows the last thing touched in the week (a point, an item, the tips
document, the quiz) with its time, and the two output states, which are the
only facts that change what the coach does next (build the sheet, build the
quiz). *Continue Game Plan* opens the week. Nothing else on Home changes.

## 10. Mobile coach entry

Constraint: the three-destination bottom bar (Quizzes · Playbooks · Team)
is not changed. Game Plan is a desktop/tablet workspace.

Evaluated:
- *Fourth bottom destination*: rejected by constraint, and the bar is a
  recorded decision.
- *"More" destination*: replaces a real destination with a menu; worse for
  the three that exist.
- *Responsive coach navigation redesign*: out of scope (the 375 px audit's
  R-1 item is a separate redesign).
- **Home "This week" card** (§9): the primary phone entry. It is at the top
  of the dashboard, which is the bar's first destination, so Game Plan is
  two taps from anywhere: Quizzes › Continue Game Plan.
- **Account menu item** "Game Plan": the secondary entry, for weeks that are
  not current (the landing page). The account menu already holds Admin View
  and Owner; a fourth item is cheap and never on the bar.
- Desktop header gains "Game Plan" as the first section link.

Phone rendering of the week page: read-first. Header stacked; the two
output chips as a row; Scouting as a vertical list of cards (snapshot
above name); points collapsed to title + emphasis line + counts, expanding
to a stacked list. **Add ▾** offers Note and From Motion Lab (the picker is
a list); *New play in Motion Lab* and *Add an answer* are hidden on phones
because Motion Lab authoring is desktop-first. Tips & Reminders on a phone:
Preview and Export only; the builder is desktop/tablet.

## 11. Empty states

Every empty state is a football sentence and one action, in the light
editorial style: no illustration, no dashed placeholder boards.

| Where | Text | Action |
|---|---|---|
| Game Plan, no weeks | **Start the week.** A week holds who you play, what they do, what we must know, and what you teach it with. | `+ New week` (opponent, label, date) |
| New week form | Opponent (optional) · Label ("Week 4", "Camp 2", "Bye") · Date (optional) | `Create week` |
| Week just created | Header only, then: **What do they do?** Add their plays from Motion Lab, draw a new one, or jot a tendency. | `Add ▾` on Scouting; `+ Point of emphasis` beneath |
| Scouting empty, points exist | **Nothing scouted yet.** Their plays and tendencies go here; drag none, just add. | `Add ▾` |
| No points of emphasis | **What must we know this week?** Name it the way you'd say it in the meeting. Tie it to a concept so Saturday's questions count toward it. | `+ Point of emphasis` (gold) |
| A point with no material | **Teach it with something.** A play from Motion Lab, an answer to one of their plays, or a reminder. | `Add ▾` |
| No Motion Lab plays in the Library | The Motion Lab picker says: **No plays yet.** Draw the first one in Motion Lab; it will be here to add. | `Open Motion Lab` |
| Tips & Reminders not started | Chip: *Tips & Reminders: Not started*. On open: **Friday's sheet, from this week.** Everything you've marked as a point is here to add. | `Add from this week` panel already open; `Add point` on the first point highlighted |
| Tips with no points in the week | **Add a point of emphasis first**, or start with a heading. | `Add heading` |
| No quiz | Chip: *Quiz: Not started*. Menu: **Build the quiz** (creates a linked quiz) · **Link an existing quiz** | |
| Quiz builder, linked week with nothing usable | Panel: **Nothing to pull in yet.** Plays added to the week will appear here as visuals. | (none) |
| Phone, week page | Same text, stacked; *New play in Motion Lab* absent with the line "Draw plays on a computer; add them here." | |

## 12. V1 CORE

The smallest Game Plan that establishes the model and is worth shipping:

1. **Week**: label, opponent, date. Create, rename, change date, delete.
   Landing: This week, Up next, Past (grouped by year). Current-week rule.
2. **Scouting + Points of emphasis** on one week page. Point: title,
   emphasis line, optional concept (existing picker), order.
3. **Items**: Play (Library reference, caption) and Note. Add from Motion
   Lab (picker), New play in Motion Lab (returns to the week), Note. Move
   between Scouting and points. Remove.
4. **Add an answer**: Library duplicate, `source_play_id`, nested display.
5. **Tips & Reminders**: block document (heading / text / picture), prefilled
   from points, Add from this week, reorder, inline edit, Export PDF via
   ReportLab, Draft / Exported states.
6. **Quiz link**: `week_id` on Quiz, Build / Link / Unlink, editor chip,
   "From this week" panel (Use concept, Use as visual, notes as reference),
   Concept field grouping.
7. **Home** This-week card; desktop nav entry; account-menu entry.

Nothing else. In particular no images, no playbook pages, no labels, no
units, no Start-from, no coverage numbers, no results.

## 13. V1.1

Each is additive and independently shippable, in this suggested order:
1. **Coverage on the Quiz chip** (concepts covered / not yet), one join.
2. **Start from a past week** (copies points and item references; not
   tips, not quizzes). The rematch case.
3. **Playbook page in Tips** (Add from playbook in the builder, printed as
   the masked render) and **Page items** on the week.
4. **Image items** (org-scoped image) and *Use as visual* for them.
5. **Add to week** from the Motion Lab Library and from a playbook page
   (file material while making it).
6. **Unit** on points (Offense / Defense / ST) with a filter, for staffs
   with two coordinators in one week.
7. **`point_id` on Question** for exact per-point coverage, if two points
   on one concept in one week proves common.

## 14. LATER

- Player delivery of Tips & Reminders through an access code with signed
  media; "opened by" as the first taught signal.
- Results by point: Taught (material) · Tested (questions by concept in the
  week's quizzes) · Understood (existing concept breakdown filtered by the
  week), Retest from the point.
- Opponent record (name match on `opponent`), opponent page across weeks.
- Motion Lab play as a native quiz visual (animated in the question).
- Clips as items and in Tips, once a clip library exists.
- "Taught today" marks on a point.
- Looks (formations) as items.
- Week templates and offseason grouping.

## 15. End-to-end walkthrough: Monday → Saturday

Counts are interactions (a click, a keypress that completes a field, a
drag). Motion Lab drawing time is not counted; it is the same in or out of
Game Plan.

**Monday.**
1. Game Plan › `+ New week` › Opponent "Miami (OH)", Label "Week 4", Date
   Sep 26 › Create. *(5)* The week opens on its empty state.
2. Scouting › `Add ▾` › *From Motion Lab* › pick "Trips Rt — Mesh" (drawn
   last week from film) › Add. *(4)* The card appears with its snapshot.
3. `+ Point of emphasis` › Title "Mesh: cut crossers, communicate bunch
   release" › Concept: Mesh (exists; picked) › Emphasis "Our call: Push ·
   Cone" › Save. *(5)*
4. On "Trips Rt — Mesh" › *Add an answer* › "vs Cover 7" › Enter. *(3)*
   Motion Lab opens the duplicate; the coach draws the defense; server
   autosave; *Back to Miami (OH) · Week 4*. The answer sits nested under the
   source in Scouting.
5. Answer card › *Move to point…* › "Mesh: cut crossers…". *(2)*
   (Alternative that saves a step: create the answer from inside the point's
   `Add ▾` › *Answer to a scouted play…*; the same duplicate, placed in the
   point. Included in V1.)

Monday total: about 19 interactions plus drawing. What PEIRA did not ask
for: no tags, no folder, no upload, no re-drawing of the offense.

**Tuesday.**
6. Source card › *Add an answer* › "vs Pressure" › Enter; draw; back. *(3)*
   Move to the point. *(2)*
7. Point › `Add ▾` › *Note* › "Nickel: #2 vertical = carry. Late call = no
   call." › Save. *(3)*

**Friday.**
8. Header chip *Tips & Reminders: Not started* › the document opens
   prefilled: heading "Mesh: cut crossers, communicate bunch release", text
   "Our call: Push · Cone", pictures "Mesh vs Cover 7", "Mesh vs Pressure",
   text "Nickel: #2 vertical = carry…", then the other points. *(1)*
9. Remove the "Jet motion" section's second picture *(1)*; move the
   reminder above the pictures *(1)*; `Add text` › "Communicate the trips
   call BEFORE the motion." *(2)*
10. `Export PDF`. *(1)* `miami-oh-week-4-tips.pdf`. Chip reads *Exported
    Fri 4:12 pm*.

Friday sheet: about 6 interactions.

11. Header chip *Quiz: Not started* › *Build the quiz*. *(2)* The builder
    opens "Miami (OH) · Week 4" with the week chip and the panel.
12. `+ Add question` › type Multiple Choice › prompt "Trips right, #3 runs
    the mesh. Who carries #2 vertical?" › options › panel: under "Mesh: cut
    crossers…", play "Mesh vs Cover 7" › *Use as visual*. *(1 for the
    visual)* The snapshot lands as the question's image and Concept becomes
    Mesh because the point carries it. The coach never opened the Concept
    field.
13. Repeat for seven more questions; two use "Mesh vs Pressure", one uses
    "Jet motion → Toss vs Spill" (Concept Toss), one has no visual. Concept
    is set on every question that came from a point.

**Saturday.** Activate as today. Results show "Teach next: Mesh, 4 of 22
missed" exactly as they would for any concept-tagged quiz, because the
questions carry Mesh. Retest builds from Mesh as today.

**What PEIRA reused:** one Motion Lab offense across three defensive
answers; the point's title, call and notes as the study sheet; the answers'
snapshots as quiz visuals; the point's concept as the question tag; and,
next year, the same plays and points when "Start from" arrives. **What PEIRA
asked the coach to organize:** which week, and optionally which point. Both
have defaults.

## 16. Failure test: why Game Plan deserves to exist

Tried, honestly, to replace it.

- **Quiz folders.** A folder holds quizzes and nothing else. It cannot hold
  a play, a note, a point, or produce a sheet. A folder named "Week 4 Miami"
  organizes the *test*, which is the last thing the week produces. Fails
  the week, keeps its job (filing quizzes).
- **Motion Lab Library folders.** A Library folder "Miami · Week 4" groups
  the plays. It cannot hold notes or points, has no concept link, cannot
  produce a sheet, and knows nothing about the quiz. It solves *where do the
  plays go*, which is why Game Plan does not add a play store. Fails the
  week.
- **Home.** Home can show "where I left off" only if a week exists to point
  at. Without the object there is nothing to continue. Home is the entry,
  not the shelf.
- **A generic document builder** ("Study Sheet" that pulls from the Library
  and playbooks). This is the strongest rival: it delivers Friday without a
  week. It fails on three counts: it has no notion of *what we must know*
  (points), so nothing links the sheet to the quiz to results; every Friday
  starts from a blank document instead of a prefilled week; and it makes
  the coach organize inside a document rather than on a shelf that both
  outputs read. Game Plan's Tips builder *is* that document builder, fed by
  the week.
- **Concepts alone.** Concepts already join teaching to testing. But a
  concept is durable and language-free ("Mesh"); a coach's week is specific
  ("cut crossers, communicate bunch release") and time-bound. Without points
  the weekly language has nowhere to live, and the concept list would fill
  with weekly phrasing (the discovery draft's mistake).

**Why it survives:** Game Plan is the only object that records *teaching
intent* between the play and the question, in the coach's words, tied to
the durable concept, and time-boxed. Every alternative can hold material
or tests; none can say what we set out to teach this week, and none can
assemble Friday and Saturday from the same shelf.

**What did not survive this test:** page and image items (Quiz and Tips
can reach playbook pages directly), labels and units, kinds, home/away,
season, week-level notes, counts on Home, coverage numbers in V1, and a
Game Plan play store. All cut.

## 17. Product-owner decisions still needed

1. **Concept optional on a point** (recommended) or required? Required
   guarantees every point is testable; optional keeps "Special teams
   reminders" honest.
2. **Answer placement in the Library**: same folder as the source
   (recommended) or a Library folder auto-created per week? The latter keeps
   the Library tidy per opponent but creates folders the coach did not make.
3. **Quiz created from a week goes to the coach's current quiz folder**
   (recommended) or to Uncategorized?
4. **Tips prefill**: every point (recommended) or start empty with the
   panel open? Prefill makes the one-press export possible.
5. **Weeks are org-shared and editable by every coach** (like folders and
   the Library, recommended) or owned with staff read access?
6. **Naming**: "Game Plan" (section), "week", "Scouting", "Points of
   emphasis", "Tips & Reminders", "Quiz" chip. Confirm.
7. **`source_play_id` in Game Plan** (recommended) versus reading a
   `duplicated_from` from the Library if P2 has one.
8. **Account-menu entry** "Game Plan" on phones (recommended) in addition to
   the Home card, or Home card only.

## 18. Recommended implementation order

Precondition: Motion Lab P2 (Library, server plays, snapshots) merged.

**GP-1 · Week + points + notes.** Week model and routes; landing; week page
with Scouting and points; Note items; concept picker on points; Home card;
desktop nav and account-menu entries; empty states. *Testable end to end
with notes only.*

**GP-2 · Plays from the Library.** Play items (picker, New play in Motion
Lab with return link, Open, snapshot cards, caption, move, remove); the
"Play removed" state. *Monday's walkthrough through step 3.*

**GP-3 · Answers.** Add an answer (Library duplicate, name, open, return),
`source_play_id`, nesting, "Answer to a scouted play…" from a point.
*Monday steps 4–5, Tuesday step 6.*

**GP-4 · Tips & Reminders.** Blocks, prefill, builder, Add from this week,
ReportLab template and export, chip states. *Friday steps 8–10.*

**GP-5 · Quiz link + panel.** `week_id`, Build / Link / Unlink, editor chip,
panel (Use concept, Use as visual with snapshot copy, notes as reference),
Concept grouping, retest inheritance. *Friday steps 11–13, Saturday.*

Each slice ships on its own, none touches Motion Lab's editor or schema,
the quiz builder's existing behavior, Results' arithmetic, or Competition.
The specification step that follows this document should be per slice,
with state tables and microcopy, in the form used for the Motion Lab
editor spec.

## 19. Discovery record (unchanged reasoning, kept for the file)

Three models were explored: a weekly board (fast, simple, at risk of being
a folder), an opponent scouting pipeline (strongest reuse, scouting-first
bias, cold start, opponent library needed), and a game-week timeline
(calendar software with a football skin). The board won, given a spine
PEIRA already owns: points of emphasis tied to Concepts, plus the
pipeline's source/answer relationship for Motion Lab plays. The refinement
above changed the spine from "a point *is* a concept" to "a point *wraps*
an optional concept", cut the item types from four to two, cut the week to
three fields, and removed counts, kinds, labels and units from V1.
