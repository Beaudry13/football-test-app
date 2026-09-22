# SPEC: Game Plan V1 (engineering handoff)

Status: SPECIFICATION, 19 September 2026. Product model approved
(`docs/DESIGN-game-plan.md`). **Nothing here is implemented. No code, no
migrations, no changes to Motion Lab, Quiz, Results, Home or Competition
were made while writing this.** Implement slice by slice (§25), never as
"build Game Plan".

Audited for this document: master at `a5b6e07` (backend conventions,
routing, dashboard, question editor, concepts, quiz, export, storage,
tests) and the Motion Lab P2 worktree at
`C:\Users\beaudrml\Documents\GitHub\football-test-app-motion-lab-p2`
(branch `feature/motion-lab-p2-library`, `b35d87b`). Every file path and
line number below comes from one of those two trees.

---

## 1. Purpose

Give a coach a place that holds a week of preparation (opponent, what they
do, what we must know, the Motion Lab plays and notes that teach it), and
assemble two outputs from it: Tips & Reminders (PDF) and the Saturday quiz
(via the quiz builder's "From this week" panel). Game Plan references
existing content (Motion Lab plays, Concepts, Quizzes); it owns only weeks,
points, items and the tips document.

## 2. V1 product contract

Owner decisions applied:
1. **Concept on a point is optional.** A point of emphasis is a weekly
   wrapper that may reference one existing Concept. No concept is ever
   created implicitly.
2. **Answers land with the source play.** "Add an answer" calls Motion
   Lab's existing copy endpoint with no `folder_id`, so the duplicate lands
   in the source's folder (`routes/motion_lab.py:164–191` behaviour). No
   answers folder, no Game Plan play store, no second library. Game Plan
   persists the relationship on its own item row.
3. **Tips & Reminders prefill from the week.** First open of a populated
   week generates an editable draft from the points (§15.2, deterministic).

V1 scope (from the approved definition, §12 there): week (label,
opponent, date); Scouting + points of emphasis on one page; items of two
kinds (play reference, note); Add an answer; Tips & Reminders with three
block kinds and PDF export; `week` link on Quiz with the "From this week"
panel (Use concept, Use as visual, notes as reference); Home "This week"
card; desktop nav entry and account-menu entry. Everything in §26 is out.

## 3. Existing architecture inventory (what the spec builds on)

**Backend (master).**
- Models: `class X(TimestampMixin, db.Model)`, integer PKs, explicit
  `__tablename__`, FKs always `index=True` with explicit `ondelete`
  (`CASCADE` for owned children, `SET NULL` for attribution/lineage,
  `RESTRICT` where the DB backs an app check), hand-written `to_dict()`
  (`backend/app/models/concept.py`, `folder.py:49–66`). Register in
  `backend/app/models/__init__.py` in dependency order and add to
  `__all__`.
- Migrations: `backend/migrations/versions/<rev>_<slug>.py`, hand-picked
  12-hex ids, prose docstring + `Revision ID / Revises`, `downgrade()`
  always written; new columns additive with `server_default`; "no backfill,
  ever". Canonical new-table migration: `b2e9d51a7c48_concepts.py:29–56`.
  Master head today: `f1a6c27b90d4` (revises `e5b2c8a41f73`).
- Routes: `xxx_bp = Blueprint("xxx", __name__)`, registered with a prefix in
  `backend/app/routes/__init__.py:27–53`; `@jwt_required()` +
  `current_coach()` (`utils/auth.py:29–34`); org scoping by a `_get_org_x`
  helper that 404s on cross-org (`routes/documents.py:30–37`); errors via
  `ApiError(message, status_code, details, reason)` (`errors.py:13–38`);
  marshmallow load-only schemas in `backend/app/schemas/`, loaded with
  `load_json_body` / `load_optional_json_body`; PATCH = `required=False`
  with no `load_default`, route does `if field in data`. No pagination
  anywhere; batch with `selectinload`. 201 on create, 204 on delete.
- Permissions: `CoachRole` admin/member; org-shared objects (folders,
  groups, players, documents, concepts) are editable by every coach in the
  org; quizzes are coach-owned (creator + admins) via
  `get_visible_quiz`/`get_editable_quiz` (`utils/auth.py:88–123`); lists
  of quizzes are own-only for everyone (`own_quizzes_query`).
- Concepts: `concepts` (org-owned, case-insensitive unique name,
  `is_archived`), routes `GET /api/concepts` (unarchived only) and
  `POST /api/concepts` (create-or-return, never 409). No rename/archive/
  delete endpoints. `Question.concept_id` validated by
  `_validated_concept_id` (`routes/questions.py:72–88`); `ON DELETE SET
  NULL`.
- Quiz: `quizzes` columns in `models/quiz.py:7–75`; `QuizCreateSchema` /
  `QuizUpdateSchema`; PATCH handles `folder_id` through `get_org_folder`
  (`routes/quizzes.py:415–419`); `to_dict(include_questions=…)`; PATCH
  responses omit `questions` and the editor spreads (`QuizEditorPage.tsx:
  52–54`).
- Question image: one door, `acceptImage(file)` in
  `QuestionEditor.tsx:326–336`; on create the image travels in the same
  multipart request as the question (`api/questions.ts:52–76`, server
  `_create_payload`, `routes/questions.py:289–329`); post-create upload is
  `POST /api/quizzes/<q>/questions/<id>/image` with form field `image`.
- Export: `services/export.py`, ReportLab platypus, `PDF_THEME` dict,
  `_pdf_styles(theme)`, `_masthead`, `_section_header`,
  `_load_image_flowable(load_image_bytes, url)` (`:998–1019`, degrades to
  `None`), `export_filename_slug`. Tests forbid `colors.X` outside the theme
  (`tests/test_export_detailed_layout.py:301–342`). Routes stream
  `Response(bytes, mimetype="application/pdf", headers={"Content-
  Disposition": 'attachment; filename="…"'})`.
- Storage: `services/file_storage.py` (`save_image`, `copy_image`,
  `delete_image`, `load_image_bytes`) for public images;
  `services/private_storage.py` + `services/signed_media.py` for private
  assets.
- Tests: `tests/conftest.py` migrates to head once, truncates per test;
  `register_coach` (new org each call), `coach_headers`, `invite_teammate`
  (second coach, same org), `make_image_file`; org isolation asserted as
  404 / empty list.
- Org-owned table registry: `services/organization_merge.py:84–89`
  (`ORG_OWNED_TABLES` + count query at 119–120) and
  `tools/production_cleanup.py:164–167, 466`; P2 added its tables there and
  Game Plan must too.

**Motion Lab P2 (branch).**
- `backend/app/models/motion_lab.py`: `motion_plays` (`id`,
  `organization_id` NOT NULL, `created_by_coach_id` SET NULL, `name`
  String(255), `document` JSONB, `schema_version`, `revision`,
  `folder_id` → `folders` SET NULL, `copied_from_play_id` → self SET NULL,
  provenance only). Hard delete, no soft-delete, no unique names, no
  snapshot column. `motion_looks` similar without folder/copy.
  `folders.area` CHECK `('quizzes','motion')`.
- Migration `b3e8d51f7a26_add_motion_lab_library.py`, **revises
  `e5b2c8a41f73`**, the same parent as master's `f1a6c27b90d4`. See §20.
- Routes `backend/app/routes/motion_lab.py` at `/api/motion-lab`:
  `GET /plays` (all org plays, full documents, no filter), `POST /plays`,
  `GET/PUT/PATCH/DELETE /plays/<id>`, **`POST /plays/<id>/copy`** with
  optional `{name?, folder_id?}` (absent `folder_id` → source's folder;
  copy gets `revision=1`, `copied_from_play_id=source`), looks routes.
  409 `reason="revision_conflict"` on stale `base_revision`; 413/422/404.
  Org scoping via `get_org_motion_play` (`utils/auth.py:191–229`).
- **Pilot gate**: every route calls `require_motion_lab_coach()` =
  `require_platform_owner()` (`utils/auth.py:175–188`, 404); frontend
  mirror `mayUseMotionLab(coach)` (`frontend/src/motion-lab/
  motionLabAccess.ts`) gates nav (`sections.ts` `visibleTo`) and routes
  (`MotionLabGate`). Documented opening path: change those two functions.
- Permission once past the gate: any coach in the org edits any play.
- Frontend: `frontend/src/api/motionLab.ts` (`listMotionPlays`,
  `getMotionPlay`, `copyMotionPlay(id, {name?, folder_id?})`,
  `updateMotionPlay`, `deleteMotionPlay`, `listMotionFolders`, …);
  `frontend/src/motion-lab/MotionLabLibraryPage.tsx` (text rows, no
  thumbnails); `MotionLabEditorPage.tsx` at `/motion-lab/plays/:playId`
  (outside `NotebookLayout`), exit link hard-coded to the Library
  (`:213–217`); the editor accepts `exit` as any `ReactNode`
  (`authoring/MotionLabEditor.tsx:186–193`).
- **No snapshot, preview or thumbnail exists anywhere.** The read-only
  renderer `frontend/src/motion-lab/view/OverheadBoard.tsx` is built for
  reuse; the working recipe is `view/OverheadBoard.test.tsx:20–47`; the
  derivation helper `derive()` lives in
  `frontend/src/motion-lab/__characterization__/capture.ts` (test
  scaffolding) and must be promoted. The board must render inside
  `.motion-lab-root` with `motionLab.css` loaded.
- Play document: `{players, ball, ballThen, engagements, situation,
  filter}`, `schema_version` 1, sanitized on read by `sanitizePlay`
  (`engine/play.ts:150–195`). Unknown keys are refused by
  `services/motion_documents.py` (no smuggling Game Plan data into plays).

**Frontend (master).**
- API modules: free functions over `api.get/post/patch/put/delete/
  postForm/getBlob` (`api/client.ts`); feature types live in the module
  (`api/concepts.ts`, `api/documents.ts`); `ApiError {status, details,
  reason}`; pages catch with `getErrorMessage`.
- Routes: `App.tsx`, protected routes inside `<Route element={<NotebookLayout/>}>`
  (L106–155). Sections: `components/notebook/sections.ts` (`SECTION_LINKS`,
  P2 adds `visibleTo` and `sectionLinksFor(coach)`); `NotebookHeader.tsx`
  account `MenuButton` (L98–114); `SectionBar.tsx` (phone bar, same list;
  width budget 270 px at 375 px).
- Page patterns: list page (`pages/documents/DocumentsPage.tsx`), detail
  page (`pages/GroupDetailPage.tsx`), `null` = loading / `[]` = empty,
  `MenuButton` for row actions, `useConfirmDialog`, `EmptyState`,
  `LoadingState`, `ErrorBanner`, `Icon` (add names to `ICONS`, never import
  lucide directly).
- Dashboard: `pages/DashboardPage.tsx`, insert point for a top card is
  L270 (first child of `.main`, above `ActiveQuizStatusSection`).
- Question editor: inline concept picker (`QuestionEditor.tsx:180–239,
  560–642`); visual sources mutually exclusive; `PlaybookPicker` renders
  inline in the visual control's slot (`PlaybookPicker.tsx:10–22`).
  `QuizEditorPage.tsx` title row with the `retestContext` precedent
  (L138–156) for a contextual chip.
- Tests: vitest + RTL, `vi.spyOn` on API modules, `MemoryRouter`,
  role-based queries; gate is `npm run test:ci`; type gate is
  `npm run build`.
- Styling: one colocated `.module.css` per page, `nb` classes, tokens
  without dark fallbacks (light-theme migration pending; new CSS must not
  add `rgba(255,255,255,…)` or hex fallbacks).

## 4. Dependency on Motion Lab P2

Game Plan V1 assumes P2 is merged and deployed first. Specifically it
depends on:

| Capability | Where | Used by |
|---|---|---|
| `motion_plays` rows, org-owned | `models/motion_lab.py` | items reference `play_id` |
| `GET /api/motion-lab/plays` | `routes/motion_lab.py:75–85` | Add from Motion Lab picker |
| `POST /api/motion-lab/plays/<id>/copy` | `:164–191` | Add an answer |
| `POST /api/motion-lab/plays` | `:88–109` | New play in Motion Lab (from the week) |
| `/motion-lab/plays/:playId` editor route + `exit` prop | `MotionLabEditorPage.tsx`, `MotionLabEditor.tsx:186–193` | Open, return link |
| `OverheadBoard` read-only renderer + engine | `view/OverheadBoard.tsx`, `engine/*` | play cards, Use as visual, PDF rasters |
| `sanitizePlay`, `SCHEMA_VERSION` | `engine/play.ts` | reading documents embedded in week responses |
| `require_motion_lab_coach` / `mayUseMotionLab` | `utils/auth.py:175`, `motionLabAccess.ts` | the gate (§7) |

Two small Motion Lab-side changes are required and are called out
explicitly rather than hidden inside Game Plan slices (§25, GP-0b):
1. **Promote the read-only board assembly** from
   `__characterization__/capture.ts` into production code
   (`frontend/src/motion-lab/view/readOnlyBoard.ts`: `deriveForBoard(play)`
   and a `<PlayBoard play time showLabels />` component wrapping
   `OverheadBoard`). No renderer change; the snapshot tests stay green.
2. **A `returnTo` search param** on `MotionLabEditorPage`: if present and
   it is a same-origin path starting with `/game-plan/`, render the `exit`
   node as "← Back to {label}" navigating there; otherwise today's Library
   exit. Ten lines; survives the editor's own play switching because it is
   in the URL.

Nothing else in Motion Lab changes: no schema, no document keys, no
endpoints, no editor behaviour.

## 5. Data model

Four new tables, one new column. All integer PKs, `TimestampMixin`.

### 5.1 `game_plan_weeks`
| column | type | null | notes |
|---|---|---|---|
| id | Integer PK | | |
| organization_id | Integer FK organizations.id ON DELETE CASCADE, index | no | visibility and editing |
| created_by_coach_id | Integer FK coaches.id ON DELETE SET NULL, index | yes | attribution only |
| label | String(80) | no | "Week 4", "Camp 2", "Bye"; stripped, 1–80 |
| opponent | String(120) | yes | free text, stripped; empty → NULL |
| game_date | Date | yes | date only, no timezone |
| created_at, updated_at | | | mixin |

Index `ix_game_plan_weeks_org_date` on `(organization_id, game_date)`.
No status, kind, season, home/away, notes, revision. "Current week" is
derived (§9.1).

### 5.2 `game_plan_points`
| column | type | null | notes |
|---|---|---|---|
| id | Integer PK | | |
| week_id | FK game_plan_weeks.id ON DELETE CASCADE, index | no | |
| title | String(255) | no | the coach's weekly words |
| emphasis | String(255) | yes | "Our call: Push · Cone" |
| concept_id | FK concepts.id ON DELETE SET NULL, index | yes | optional durable link |
| position | Integer | no | 0-based within the week; unique per week enforced by the reorder route, not the DB |
| created_at, updated_at | | | |

No `coach_id`. No second taxonomy: `title` is never copied into
`concepts`.

### 5.3 `game_plan_items` (one table, two kinds)
| column | type | null | notes |
|---|---|---|---|
| id | Integer PK | | |
| week_id | FK game_plan_weeks.id ON DELETE CASCADE, index | no | |
| point_id | FK game_plan_points.id ON DELETE SET NULL, index | yes | NULL = Scouting |
| kind | String(8) CHECK IN ('play','note') | no | |
| position | Integer | no | order within its container (a point, or Scouting) |
| play_id | FK motion_plays.id ON DELETE SET NULL, index | yes | kind=play |
| play_name | String(255) | yes | kind=play; copied at add time; shown only when `play_id` is NULL ("Play removed") |
| source_play_id | FK motion_plays.id ON DELETE SET NULL, index | yes | kind=play; the scouted play this is an answer to |
| caption | String(160) | yes | kind=play |
| note_title | String(120) | yes | kind=note |
| note_text | Text | yes | kind=note; ≤ 2000 chars |
| created_at, updated_at | | | |

CHECK constraints: `(kind = 'play' AND play_name IS NOT NULL AND note_title
IS NULL AND note_text IS NULL) OR (kind = 'note' AND note_title IS NOT NULL
AND play_id IS NULL AND source_play_id IS NULL AND caption IS NULL)`.

**Why one polymorphic table, not two.** Play and note items are interleaved
in one ordered list inside a point and inside Scouting; two tables would
need a shared ordering column across tables or a third "slot" table. The
kinds share every structural column (week, point, position, timestamps)
and differ in four nullable ones. This matches how `questions` holds five
question types in one table with per-type nullable columns. Adding a third
kind later (image, page) is a `kind` value plus columns.

**Why `play_id` is SET NULL, not CASCADE.** Play deletion in Motion Lab is
a hard delete with a confirm that promises "copies made from it are not
affected" (`MotionLabLibraryPage.tsx:341–353`). A week that referenced
the play should not silently lose a card and a tips picture: the item
survives with `play_name` and renders "Play removed" (§19).

### 5.4 `game_plan_tips`
| column | type | null | notes |
|---|---|---|---|
| id | Integer PK | | |
| week_id | FK game_plan_weeks.id ON DELETE CASCADE, unique, index | no | one per week |
| blocks | JSONB | no | ordered array, §15.1 |
| exported_at | DateTime(tz) | yes | last successful PDF export |
| created_at, updated_at | | | |

Blocks are one JSONB document, not rows: the whole document is edited and
saved as a unit (PUT), it is small (≤ 200 blocks, ≤ 64 KB enforced), and
the PDF builder consumes it whole. No revision column in V1 (last write
wins; §27 Q3).

### 5.5 `quizzes.game_plan_week_id`
Integer FK `game_plan_weeks.id` ON DELETE SET NULL, nullable, index
`ix_quizzes_game_plan_week_id`. PATCHable and settable at create. This is
the cleanest link: it mirrors `retest_of_quiz_id` and `folder_id` (both
nullable FKs on the quiz, both resolved through an org helper on PATCH),
it keeps Quiz independently usable (NULL is the default), and it lets the
week list its quizzes with one query. A join table was rejected: a quiz
belongs to at most one week and Game Plan does not own the quiz.

### 5.6 Registry updates
Add `game_plan_weeks`, `game_plan_points`, `game_plan_items`,
`game_plan_tips` to `ORG_OWNED_TABLES` in
`services/organization_merge.py` (and the count query) and to
`tools/production_cleanup.py`, exactly as P2 did for `motion_plays`.

## 6. Relationship model

```
Organization ─┬─< game_plan_weeks ─┬─< game_plan_points ──(optional)──> concepts
              │                    │         │
              │                    │         └─< game_plan_items (point_id set)
              │                    ├─< game_plan_items (point_id NULL = Scouting)
              │                    │         ├── play_id ────────> motion_plays   (reference, SET NULL)
              │                    │         └── source_play_id ─> motion_plays   (reference, SET NULL)
              │                    ├── game_plan_tips (1:1)  blocks[].play_id ──> motion_plays (soft reference inside JSON)
              │                    └─< quizzes.game_plan_week_id (optional, SET NULL)
              ├─< motion_plays  (Motion Lab owns; copied_from_play_id is Motion Lab provenance, not used by Game Plan)
              ├─< concepts      (org owns)
              └─< quizzes ─< questions.concept_id ──> concepts
```

Ownership: Game Plan owns weeks, points, items, tips. Motion Lab owns
plays. Quizzes own themselves; the week only holds a back-reference. The
Concept is owned by the org; a point references it; a question references
it; the join between "taught" and "tested" is `points.concept_id =
questions.concept_id` over `quizzes.game_plan_week_id = week.id`.

## 7. Ownership and permissions

Game Plan objects are **org-shared, like folders, groups, playbooks and
Motion Lab plays**: any coach in the organization may create, edit,
reorder and delete any week, point, item and tips document in that
organization. `created_by_coach_id` is attribution. Cross-org access is a
404 (`_get_org_week` modelled on `_get_org_document`).

| Action | Rule |
|---|---|
| Create / rename / date / delete week | any org coach |
| Add / edit / reorder / delete points | any org coach |
| Add / move / caption / remove items | any org coach |
| Add an answer | any org coach (it also requires Motion Lab access, below) |
| Edit tips, export tips | any org coach |
| Link a quiz to a week | the quiz must pass `get_editable_quiz` (creator or admin) **and** the week must be in the same org; unlinking has the same rule |
| Build the quiz from the week | creates a quiz owned by the caller (`POST /api/quizzes` semantics) with `game_plan_week_id` set |

**Pilot gate.** Every Motion Lab endpoint is behind
`require_motion_lab_coach()` (platform owner only, 404). Game Plan V1 is
gated identically: a new `require_game_plan_coach()` in `utils/auth.py`
that returns `require_motion_lab_coach()`, and a frontend
`mayUseGamePlan(coach)` that returns `mayUseMotionLab(coach)`. Opening
Game Plan to all coaches is then the same two-function change as opening
Motion Lab, and the two open together (they must: a Game Plan without
Motion Lab access would 404 on every play action). §28 Q1.

No new role, no per-week ownership, no admin-only Game Plan action.

## 8. Routes

Backend blueprint `game_plan_bp`, registered at `/api/game-plan`
(`routes/__init__.py`). Frontend, inside `NotebookLayout`
(`App.tsx` L106–155 block), wrapped in a `GamePlanGate` modelled on
`MotionLabGate`:

| Path | Page | Purpose |
|---|---|---|
| `/game-plan` | `GamePlanPage` | landing: This week, Up next, Past, New week |
| `/game-plan/weeks/:weekId` | `WeekPage` | the workspace |
| `/game-plan/weeks/:weekId/tips` | `TipsPage` | the builder |

Direct links: all three are bookmarkable; an unknown or cross-org
`weekId` renders the page-level not-found panel ("This week isn't in your
Game Plan" + link to `/game-plan`), matching `MotionLabEditorPage`'s
unknown-play panel. Deep links from Home (`/game-plan/weeks/12`), from the
quiz editor chip (`/game-plan/weeks/12`), and back from Motion Lab
(`?returnTo=/game-plan/weeks/12`).

`sections.ts` gains `{ to: '/game-plan', label: 'Game Plan', isActive:
path => path.startsWith('/game-plan'), tour: 'game-plan', visibleTo:
mayUseGamePlan }` as the **first** entry. The phone `SectionBar` reads the
same list; because of the 270 px budget documented in `SectionBar.tsx:
12–18`, the Game Plan entry carries `phone: false` (a new optional flag
the bar honours) so the bottom bar stays at three (§18).

## 9. Game Plan landing (`/game-plan`)

Data: `GET /api/game-plan/weeks` (all org weeks, §21.1). The page derives
three groups client-side from `game_date` and `updated_at`:

### 9.1 Current-week rule (used by the landing, Home, and `GET /current`)
1. Among weeks with `game_date >= today` (org-local date, server uses
   UTC date; §27 Q4): the one with the smallest `game_date`; ties by
   `updated_at` desc.
2. Else among weeks with `game_date IS NULL`: the most recently
   `updated_at`.
3. Else (all dated in the past): the most recent `game_date`.
4. No weeks: none.

### 9.2 Layout
- Header: `h1` "Game Plan" (`nb.heading`), primary action **+ New week**
  (inline form: Opponent, Label, Date; Create).
- **This week**: one hero card (opponent as the heading face, "Week 4 ·
  Sat Sep 26", last-touched line from `GET /current`, tips and quiz
  states) with **Open week**. Absent when there are no weeks (the empty
  state replaces the whole body, §23).
- **Up next**: weeks with a future date other than the current one, rows
  sorted by date.
- **Past weeks**: grouped by year of `game_date` (undated, non-current
  weeks appear in a final "No date" group), rows sorted by date desc.
  Each row: opponent (or label when no opponent), label · date, tips /
  quiz state words, and a `MenuButton` "Options for {name}": Open ·
  Rename… · Delete… (confirm names the counts: points, items, whether tips
  exist, and that linked quizzes stay).

No counts of items, no analytics, no search (search is explicitly not
approved elsewhere in PEIRA and is not added here).

## 10. Week workspace (`/game-plan/weeks/:weekId`)

Data: `GET /api/game-plan/weeks/<id>` returns the week, its points, its
items (with embedded play rows), tips state, and linked quizzes in one
response (§21.2). One load, then optimistic local updates with the
existing `setError(getErrorMessage(err))` pattern on failure.

Hierarchy, top to bottom:
1. **Back link** "← Game Plan".
2. **Header**: opponent as `h1` (label as `h1` when no opponent), meta
   "Week 4 · Sat Sep 26" (or just the label), and on the right two chips:
   `Tips & Reminders: {Not started | Draft | Exported Fri 4:12 pm} ▸` →
   `/tips`; `Quiz: {Not started | Draft | Out with players | Results} ▸` →
   a menu when not started (**Build the quiz**, **Link an existing
   quiz…**), else a link to the quiz (`/quizzes/:id`, `?tab=results` when
   results exist). A `MenuButton` "Options for {name}": Rename…, Change
   date…, Delete week….
3. **Scouting** (`h2` "Scouting", sub "What they do"): the items with
   `point_id = NULL`, ordered by `position`, rendered as cards (§12.3).
   Section action **Add ▾**: From Motion Lab…, New play in Motion Lab,
   Note.
4. **Points of emphasis** (`h2`, sub "What we must know"): ordered rows
   (§11). Section action **+ Point of emphasis**.

The single gold (primary) button follows state: `+ Point of emphasis`
when there are no points; the Tips chip styled primary when points exist
and tips are "Not started"; the Quiz chip primary when tips exist and no
quiz is linked; otherwise none is primary. Purely presentational.

Quiz state words derive from the linked quiz rows: no quiz → Not
started; quiz with no active code and no attempts → Draft; active code →
Out with players; any submitted attempt → Results. When several quizzes
are linked, the chip shows the most advanced state and the menu lists all
of them.

## 11. Points of emphasis

**Create** (`+ Point of emphasis`): inline form at the bottom of the list
with Title (required), Emphasis (optional, placeholder "Our call: …"),
Concept (optional; the extracted `ConceptPicker`, §22, with "Untagged"
default and "New"). Enter saves. `POST /weeks/<id>/points` with position =
count. The new row appears expanded.

**Row** (collapsed): number, title, concept chip (name, or a muted "No
concept"), counts ("3 plays · 2 notes", derived), expand toggle. Expanded:
emphasis line, the point's items as a compact strip (§12.3, small), and
**Add ▾**: From Motion Lab…, New play in Motion Lab, Answer to a scouted
play…, Add from Scouting…, Note. Row menu: Edit… (title, emphasis,
concept), Move to position…, Delete….

**Edit**: `PATCH /points/<id>` with any of `title`, `emphasis`,
`concept_id` (null clears). Concept validation: must exist in the same org
(`_validated_concept_id` logic reused; archived concepts are accepted for
an existing reference but not offered by the picker).

**Ordering**: `PUT /weeks/<id>/points/order` with the full id list;
"Move to position" is PEIRA's pattern (no drag-and-drop). Positions are
rewritten 0..n-1.

**Delete**: confirm "Delete this point? Its {n} items move to Scouting."
`DELETE /points/<id>`; the FK `SET NULL` on `items.point_id` performs the
move; the route then renumbers those items to the end of Scouting.

**"Also taught in"** hint: when the chosen concept is referenced by a
point in another week of the org, the form shows "Also taught in Week 2 ·
Toledo" (from `GET /concepts/<id>/weeks`, §21.7). Read-only, optional.

## 12. Week material (items)

### 12.1 Add from Motion Lab
Picker (`MotionPlayPicker`, §22) listing `listMotionPlays()` grouped by
folder (`listMotionFolders()` for names), each row a small live board
(`PlayBoard`, §4) plus name and updated date, multi-select, **Add {n}**.
`POST /weeks/<id>/items` per selection (or one bulk call, §21.3) with
`{kind: 'play', play_id, point_id?}`. Plays already in this week (any
container) are shown checked and disabled with "In this week".

Cost note: `GET /api/motion-lab/plays` returns every play's full document.
Acceptable for V1 pilot libraries; the picker renders boards lazily
(IntersectionObserver) so 100 plays do not compute 100 schedules up
front. A summary endpoint is a Motion Lab optimisation for later, not a
V1 requirement (§27 Q2).

### 12.2 New play in Motion Lab
`createMotionPlay({name: '', document: toDocument(newPlay()), schema_version,
folder_id: null})` exactly as the Library's "New play" does
(`MotionLabLibraryPage.tsx:112–130`), then `POST /weeks/<id>/items` with
the new `play_id` (and `point_id` when started from a point), then
`navigate('/motion-lab/plays/' + id + '?returnTo=/game-plan/weeks/' +
weekId)`. The item exists before the editor opens, so a coach who leaves
without drawing still has the card ("Untitled play") to rename or remove.
Name default: "{opponent} · New play" when the week has an opponent, else
"New play".

### 12.3 Cards
Play card: `PlayBoard` at t = 0 with labels, `pathVisible` from the play's
`filter`, inside `.motion-lab-root` (the week page imports
`motionLab.css` once); name; caption line; for a source play, its answers
nested beneath (items in the week whose `source_play_id` = this play's id,
wherever they sit) as "vs Cover 7" links. Card menu: Open (→ editor with
`returnTo`), Add an answer… (§14), Move to point… / Move to Scouting,
Edit caption…, Remove from week.
Note card: title, text (clamped to 6 lines with "More"), menu: Edit…,
Move…, Remove.
"Play removed" card: `play_id` NULL: grey board placeholder, `play_name`,
"Play removed from Motion Lab", menu: Remove.

### 12.4 Notes
`POST /weeks/<id>/items {kind:'note', note_title, note_text, point_id?}`.
Inline form (title, text). Edit via `PATCH /items/<id>`.

### 12.5 Moving
`PATCH /items/<id> {point_id: <id> | null}` moves an item between Scouting
and a point; the route appends it at the end of the target container and
renumbers the source. "Add from Scouting…" inside a point is a picker over
Scouting items that issues the same PATCH.

### 12.6 Removing
`DELETE /items/<id>`; never touches `motion_plays`. Confirm only when the
item is a source with answers in the week ("Its {n} answers stay in the
week as ordinary plays.").

## 13. Motion Lab integration (summary of contract)

| Game Plan action | Motion Lab call | Notes |
|---|---|---|
| Add from Motion Lab | `GET /api/motion-lab/plays`, `GET /api/folders?area=motion` | read only |
| New play in Motion Lab | `POST /api/motion-lab/plays` | as the Library does |
| Open | navigate `/motion-lab/plays/:id?returnTo=…` | `returnTo` handled by the editor page (§4) |
| Add an answer | `POST /api/motion-lab/plays/:id/copy {name}` | no `folder_id` → source's folder |
| Cards, Use as visual, PDF rasters | `PlayBoard` (client render) | no Motion Lab endpoint |
| Rename / edit / delete plays | none | done in Motion Lab; Game Plan reads live names |

Game Plan never PUTs a play document, never writes `motion_plays`
directly, never reads `copied_from_play_id`.

## 14. Source / answer behaviour

**Add an answer** (source card, or a point's "Answer to a scouted
play…" which first picks a source among the week's Scouting plays):
1. Prompt for the answer label (single field, placeholder "vs Cover 7",
   required, ≤ 60 chars).
2. Client calls `copyMotionPlay(source.play_id, { name: `${sourceName} vs
   ${label}`.slice(0, 255) })`. No `folder_id`: the copy lands in the
   source's folder (owner decision 2).
3. `POST /weeks/<id>/items {kind:'play', play_id: copy.id, source_play_id:
   source.play_id, point_id: <the point if started from one, else null>}`.
4. `navigate('/motion-lab/plays/' + copy.id + '?returnTo=…')`. The coach
   draws the defense; Motion Lab autosaves; the exit link returns to the
   week.

The source is untouched (a copy is a new row with `revision=1`). Game Plan
persists `source_play_id` on the answer item; that is the whole
relationship. Motion Lab's `copied_from_play_id` is not read (it is
provenance for any duplicate, including Library "Duplicate", and it does
not mean "answer").

| Event | Effect in Game Plan |
|---|---|
| Source renamed in Motion Lab | Cards show the live name; answer names keep the old prefix (they are their own plays). Nothing rewritten. |
| Source edited | Nothing; answers are copies. |
| Answer renamed / edited | Nothing elsewhere. |
| Source play deleted (Motion Lab hard delete) | Source item: `play_id` → NULL, shows "Play removed". Answer items: `source_play_id` → NULL, they un-nest and become ordinary play items. |
| Answer play deleted | That item shows "Play removed"; the source's answer list shrinks. |
| Week deleted | Items, points, tips cascade. Plays (source and answers) remain in the Library untouched. Quizzes get `game_plan_week_id = NULL`. |
| Source item removed from the week | Answer items stay; nesting disappears (no row to nest under). `source_play_id` is kept so re-adding the source re-nests them. |
| Answer item removed from the week | The play stays in the Library. |

No live inheritance in either direction, by design and by construction
(there is no mechanism that could propagate).

## 15. Tips & Reminders

### 15.1 Persistence
`game_plan_tips.blocks` is an ordered JSON array. Block shapes (validated
by a marshmallow schema on PUT; unknown keys rejected):
```
{ "id": "b_7f3a", "kind": "heading", "text": "Mesh: cut crossers…" }          text 1–160
{ "id": "b_9c1d", "kind": "text",    "text": "Nickel: #2 vertical = carry." }  text 1–2000
{ "id": "b_02e4", "kind": "picture", "play_id": 41, "caption": "Mesh vs Cover 7" }  caption ≤160
```
`id` is client-generated (8 hex), unique within the document; the server
rejects duplicates. Limits: ≤ 200 blocks, ≤ 40 pictures, document ≤ 64 KB.
A picture's `play_id` must be a play in the caller's org at save time
(422 otherwise); at render time a missing play prints as "Diagram
unavailable" (§15.4).

### 15.2 Initial draft (deterministic, no AI)
`POST /weeks/<id>/tips` (only when no tips row exists; 409-free: returns
200 with the existing row if it exists) builds:
1. For each point in `position` order:
   - `heading` = point title.
   - `text` = point emphasis, if set.
   - For each item in the point in `position` order: `kind=play` with a
     live play → `picture {play_id, caption: item.caption ?? play.name}`;
     `kind=play` with `play_id` NULL → skipped; `kind=note` → `text` =
     `note_title` + ": " + `note_text` (title omitted when empty).
2. Scouting items are not included (the coach adds them).
3. A week with no points produces an empty `blocks: []`.

Nothing from the week is copied afterwards; the tips document is its own.
**Reset from week** (`POST /weeks/<id>/tips/reset`) rebuilds the same way
after a confirm.

### 15.3 Builder page (`/tips`)
- Header: back link to the week, `h1` "Tips & Reminders", state word,
  actions: **Reset from week** (quiet), **Preview** (opens the PDF in a
  new tab), **Export PDF** (primary).
- Left column, **Add from this week**: each point as a group with **Add
  point** (adds its blocks per §15.2 for that point only, appended at the
  end), each play/note beneath with **Add** (a single block); Scouting
  items with **Add**; blocks already present (same `play_id`, or same
  note text) show a check instead of Add. Below: **Add heading**, **Add
  text**.
- Right column, the document: header block (TIPS & REMINDERS / opponent /
  label · date; not editable, not a block), then blocks. Each block: ↑ ↓ ×
  controls; heading and text edit inline (blur saves); picture shows the
  `PlayBoard` with an editable caption.
- Saving: every change PUTs the whole `blocks` array, debounced 600 ms,
  "Saving… / Saved" text as in Motion Lab's status line; a failed PUT shows
  the error banner and keeps local state; retry on next change.
- Phone: Preview and Export only; the builder columns stack read-only with
  a note "Edit on a computer."

### 15.4 PDF export
The engine is TypeScript and stays the only engine
(`docs/MOTION-LAB-BASELINE.md`), so diagrams are rasterised in the browser
and sent with the export request:
1. Client renders each picture block's `PlayBoard` to PNG at 1200 px width
   (SVG serialised with computed styles inlined, drawn to a canvas;
   utility `renderPlayToPng(play): Promise<Blob>` in
   `frontend/src/motion-lab/view/playRaster.ts`, GP-0b). Failures yield no
   file for that block.
2. `POST /api/game-plan/weeks/<id>/tips/export.pdf` as multipart:
   `blocks` (JSON string of the current document, so unsaved edits are
   printed as seen) and one file per picture block named
   `picture_<blockId>` (PNG ≤ 600 KB each, ≤ 40 files).
3. Server (`services/game_plan_export.py`, `build_tips_pdf(week, blocks,
   pictures: dict[block_id, bytes], organization_name, theme=None) ->
   bytes`): letter, `_masthead` with "TIPS & REMINDERS" eyebrow, opponent
   as display heading, "label · date" line; `heading` → `_section_header`;
   `text` → body paragraph (lines starting with "- " become bullets);
   consecutive `picture` blocks flow into a two-column table (each cell
   the image scaled to the column width, caption beneath in the label
   style); a lone picture is centred at up to 4.5 in wide; a picture with
   no file prints a bordered box "Diagram unavailable: {caption}"; footer
   "{organization} · {opponent} · {label} · page n". All colours from
   `PDF_THEME`; any new key added to the required-key test.
4. Response: `application/pdf`, `Content-Disposition: attachment;
   filename="{slug(opponent or label)}-{slug(label)}-tips.pdf"`. On
   success the server sets `exported_at = now` (the export endpoint is the
   only writer of that column) and the week chip reads "Exported Fri 4:12
   pm" on the next load; the client updates it optimistically.
5. Preview = the same request opened in a new tab (`getBlob` → object URL).

Nothing is stored for the PDF: no rasters, no PDF bytes.

## 16. Quiz "From this week"

### 16.1 Linking
- `QuizCreateSchema` and `QuizUpdateSchema` gain `game_plan_week_id =
  fields.Int(required=False, allow_none=True)`; the route resolves a
  non-null id through `_get_org_week` (404 cross-org) exactly like
  `folder_id` (`routes/quizzes.py:415–419`).
- `Quiz.to_dict()` emits `game_plan_week: {id, label, opponent} | null`
  (always present, like `retest_of`), and `game_plan_week_id`.
- Week chip **Build the quiz**: `createQuiz({title: "{opponent} · {label}",
  game_plan_week_id})` then navigate to `/quizzes/:id`. **Link an existing
  quiz…**: a picker over `listQuizzes()` (own quizzes; admins see their own
  too, the org-wide list is not used) → `updateQuiz(id, {game_plan_week_id})`.
- Quiz editor: in `titleRow`, next to the `retestContext` precedent, a
  `Link` chip "{opponent} · {label}" to the week when `quiz.game_plan_week`
  is set; the quiz's `…` actions gain **Unlink from week** (PATCH null).
  `applyPatched` spreads, so the field survives PATCH responses.
- Retest: `create_retest` copies `game_plan_week_id` from the original
  (`routes/quizzes.py:543` constructor gains one argument).

### 16.2 The panel
Rendered by `QuestionEditor` **inside the form, in the visual control's
slot**, the way `PlaybookPicker` is (option 1 in the audit): a button
**From this week** appears beside Upload / Choose from Playbook / Record a
Clip only when the quiz has `game_plan_week`. Clicking it replaces the
visual control with `FromThisWeekPanel` (data: `GET /weeks/<id>` once per
editor mount, cached in `QuestionsTab` and passed down):

| Row | Action | Effect |
|---|---|---|
| Point (title · concept name) | **Use concept** | `setConceptId(point.concept_id)`. Rendered disabled with "No concept" when null. Never creates a concept. |
| Play under a point / in Scouting (small board, name) | **Use as visual** | `renderPlayToPng(play)` → `new File([blob], `${name}.png`, {type:'image/png'})` → `acceptImage(file)` (the one door, `QuestionEditor.tsx:326`). If the point has a concept and `conceptId` is null, also `setConceptId`. The panel closes and the preview shows the PNG. The image is then saved by the existing create/upload path: a copy owned by the question, the single-owner rule intact. |
| Note (title, text) | **Copy** | `navigator.clipboard.writeText(text)`; nothing else. |
| Cancel | | closes the panel |

Why a raster and not a play reference: the quiz has no visual source type
for plays; the delivered snapshot, results, exports and the player page
all expect `question_images`. A reference type is a Quiz feature for
later (§26). The raster is exactly what "Use as visual" promises: the
diagram as a picture.

Concept field grouping: when the quiz has a week, `conceptOptions` is
rendered as two `<optgroup>`s, "This week" (the week's points' concepts,
deduplicated, in point order) and "All concepts". No API change.

## 17. Home "This week"

Data: `GET /api/game-plan/current` (§21.6) → `null` or:
```
{ "week": {id, label, opponent, game_date},
  "last_touched": {"kind": "point"|"item"|"tips"|"quiz"|"week", "title": "Mesh: cut crossers…", "at": "2026-09-17T21:40:00Z"},
  "tips_state": "not_started"|"draft"|"exported", "tips_exported_at": null|ts,
  "quiz_state": "not_started"|"draft"|"live"|"results", "quiz_id": null|id }
```
`last_touched` = the newest `updated_at` among the week row, its points,
its items, its tips row and its linked quizzes; `title` is the point
title / item title (play name or note title) / "Tips & Reminders" / quiz
title / "Week".

Component `ThisWeekCard` (`pages/ThisWeekCard.tsx`), inserted at
`DashboardPage.tsx` L270 as the first child of `.main`, above "Live now":
eyebrow "THIS WEEK", opponent (or label) in the heading face, "label ·
date", one line `Last: "{title}" · {relative time}`, one line `Tips &
Reminders: {word} · Quiz: {word}`, primary **Continue Game Plan** →
`/game-plan/weeks/:id`. Renders `null` when the endpoint returns `null`,
when the coach fails `mayUseGamePlan`, or on error (the card never blocks
the dashboard; it fetches once on mount, not polled). It sits above "Live
now" because it is where the coach resumes work and a live quiz is already
announced by the banner and rail; no counts are shown.

## 18. Mobile coach access

- Bottom `SectionBar` unchanged: three destinations. The Game Plan
  section link has `phone: false`; `SectionBar` skips such links
  (a two-line change in `SectionBar.tsx`, the desktop header ignores the
  flag).
- Entry 1: the Home card (above), two taps from anywhere.
- Entry 2: account menu (`NotebookHeader.tsx:98–114`) gains
  `<MenuLink to="/game-plan">Game Plan</MenuLink>` when `mayUseGamePlan`.
- Week page below 40rem: header stacks; chips wrap; Scouting and point
  strips become vertical lists; **New play in Motion Lab** and **Add an
  answer** are hidden (Motion Lab authoring is desktop-first by decision);
  Note and From Motion Lab remain. Tips page: Preview/Export only. Nothing
  else in mobile PEIRA changes.

## 19. Deletion and data safety

Principle: Game Plan references; deleting a reference never deletes the
referenced thing; deleting a referenced thing degrades the reference,
never the week.

| Event | Result |
|---|---|
| Week deleted | Points, items, tips cascade (DB). `quizzes.game_plan_week_id` → NULL (DB). Motion Lab plays untouched. Confirm dialog states the counts and "Quizzes stay; they are just unlinked." |
| Point deleted | Items' `point_id` → NULL (DB); route renumbers them at the end of Scouting. Concept untouched. |
| Concept deleted | Not possible today (no endpoint). If Phase B adds it: `points.concept_id` → NULL (DB); the point shows "No concept". Archived concept: point keeps the reference and shows "(archived)". |
| Motion Lab source play deleted | `items.play_id` → NULL, `play_name` kept, card "Play removed"; answer items' `source_play_id` → NULL. Tips picture blocks referencing it print "Diagram unavailable". |
| Motion Lab answer play deleted | Same for that item. |
| Quiz deleted | Gone as today; the week's quiz chip returns to Not started. |
| Item removed from a week | Row deleted; the play stays in the Library; tips blocks are not touched (the document is independent). |
| Tips reset | Blocks replaced after confirm; `exported_at` kept. |
| Organization merge | Tables listed in `ORG_OWNED_TABLES`; rows move with their org; FKs to plays/concepts/quizzes stay valid because those move too. |

No soft delete on any Game Plan table in V1.

## 20. Migration plan

**Precondition (not a Game Plan migration): one head.** Master's head
`f1a6c27b90d4` and P2's `b3e8d51f7a26` both revise `e5b2c8a41f73`.
Merging P2 as-is yields two heads and `flask db upgrade` refuses. The P2
merge must include either a rebase of `b3e8d51f7a26` onto `f1a6c27b90d4`
(preferred: edit `down_revision`) or an Alembic merge revision. Game Plan
migrations set `down_revision` to that single head. This is a genuine
blocker for GP-1 and is listed in §27.

Then two revisions, in order:

**GP migration 1: `<rev>_add_game_plan.py`**
- `create_table game_plan_weeks` (§5.1) + `ix_game_plan_weeks_organization_id`,
  `ix_game_plan_weeks_created_by_coach_id`, `ix_game_plan_weeks_org_date`.
- `create_table game_plan_points` (§5.2) + `ix_game_plan_points_week_id`,
  `ix_game_plan_points_concept_id`.
- `create_table game_plan_items` (§5.3) with the CHECK constraints
  `ck_game_plan_items_kind` and `ck_game_plan_items_kind_columns`, +
  `ix_game_plan_items_week_id`, `_point_id`, `_play_id`, `_source_play_id`.
- `create_table game_plan_tips` (§5.4) + `uq_game_plan_tips_week_id`.
- FK names `fk_<table>_<column>`; all `ondelete` as in §5.
- `downgrade()`: drop in reverse order.

**GP migration 2: `<rev>_link_quizzes_to_game_plan_weeks.py`**
- `add_column quizzes.game_plan_week_id Integer nullable`,
  `ix_quizzes_game_plan_week_id`, `fk_quizzes_game_plan_week_id` ON DELETE
  SET NULL. Additive; no backfill. `downgrade()` drops FK, index, column.

Separate revisions so the quiz link can ship in GP-5 without touching the
tables from GP-1 again, and so a rollback of the quiz link alone is
possible. No enums are added (kind is a String + CHECK, avoiding the enum
one-way door). No `folders.area` change (Game Plan has no folders).

## 21. API contract

Blueprint `game_plan_bp`, prefix `/api/game-plan`. Every route:
`@jwt_required()`, `coach = require_game_plan_coach()`, org scoping via
`_get_org_week(week_id)` / `_get_org_point` / `_get_org_item` (404 on
cross-org). Validation via marshmallow schemas in
`backend/app/schemas/game_plan.py`. Errors follow `ApiError` shapes.

Common serialisations:
```
Week      {id, organization_id, label, opponent, game_date, created_by_coach_id, created_at, updated_at}
Point     {id, week_id, title, emphasis, concept: {id,name,is_archived}|null, position, created_at, updated_at}
Item      {id, week_id, point_id, kind, position, caption, note_title, note_text,
           play: MotionPlayRow|null, play_name, source_play_id, created_at, updated_at}
Tips      {id, week_id, blocks, exported_at, created_at, updated_at}
WeekDetail {week, points: Point[], items: Item[], tips: {state, exported_at, id|null},
            quizzes: [{id, title, state, is_active, completed_count}]}
```
`Item.play` embeds `MotionPlay.to_dict()` (document included) so cards
render without a second call; it is `null` when `play_id` is NULL.

### 21.1 Weeks
| Method / path | Purpose | Request | Response | Validation |
|---|---|---|---|---|
| `GET /weeks` | list org weeks | — | 200 `Week[]` ordered `game_date DESC NULLS LAST, updated_at DESC` | — |
| `POST /weeks` | create | `{label, opponent?, game_date?}` | 201 `Week` | label 1–80 stripped; opponent ≤120, blank→null; date ISO `YYYY-MM-DD` or null |
| `GET /weeks/<id>` | detail | — | 200 `WeekDetail` | batched: points, items with `selectinload(play)`, tips, quizzes in ≤ 5 queries |
| `PATCH /weeks/<id>` | rename / date | any of `{label, opponent, game_date}` | 200 `Week` | as create; absent = unchanged |
| `DELETE /weeks/<id>` | delete | — | 204 | — |
| `GET /current` | Home card | — | 200 `null` or §17 shape | rule §9.1 |

### 21.2 Points
| Method / path | Purpose | Request | Response | Validation |
|---|---|---|---|---|
| `POST /weeks/<id>/points` | create | `{title, emphasis?, concept_id?}` | 201 `Point` | title 1–255; emphasis ≤255; concept must be in org (422 "That concept does not exist"); position appended |
| `PATCH /points/<id>` | edit | any of `{title, emphasis, concept_id}` | 200 `Point` | `concept_id: null` clears |
| `PUT /weeks/<id>/points/order` | reorder | `{point_ids: [..]}` | 200 `Point[]` | must be a permutation of the week's point ids (422 otherwise) |
| `DELETE /points/<id>` | delete | — | 204 | items → Scouting, renumbered |

### 21.3 Items
| Method / path | Purpose | Request | Response | Validation |
|---|---|---|---|---|
| `POST /weeks/<id>/items` | add one or many | `{items: [{kind:'play', play_id, source_play_id?, caption?, point_id?} \| {kind:'note', note_title, note_text, point_id?}]}` | 201 `Item[]` | play ids via `get_org_motion_play` (404 cross-org); `source_play_id` same; point must belong to the week; a play already in the week → 422 `reason="already_in_week"`; ≤ 50 per call; note_title 1–120, note_text ≤ 2000; caption ≤160; `play_name` copied from the play |
| `PATCH /items/<id>` | edit / move | any of `{caption, note_title, note_text, point_id}` | 200 `Item` | `point_id` null = Scouting; moving appends to the target container |
| `PUT /weeks/<id>/items/order` | reorder within a container | `{point_id: id\|null, item_ids: [..]}` | 200 `Item[]` | permutation of that container's items |
| `DELETE /items/<id>` | remove | — | 204 | never touches plays |

### 21.4 Tips
| Method / path | Purpose | Request | Response | Validation |
|---|---|---|---|---|
| `GET /weeks/<id>/tips` | read | — | 200 `Tips`, or 404 when not started | — |
| `POST /weeks/<id>/tips` | create the draft (§15.2) | — | 201 `Tips`; 200 existing if present | — |
| `PUT /weeks/<id>/tips` | save blocks | `{blocks: [...]}` | 200 `Tips` | schema §15.1; limits; picture `play_id` in org |
| `POST /weeks/<id>/tips/reset` | rebuild from week | — | 200 `Tips` | — |
| `POST /weeks/<id>/tips/export.pdf` | export | multipart: `blocks` (JSON string), `picture_<blockId>` files | 200 `application/pdf`, sets `exported_at` | ≤ 40 files, each ≤ 600 KB, PNG/JPEG only (Pillow-verified); unknown block ids ignored; 413 on oversize |

### 21.5 Quiz link (on `quizzes_bp`)
- `POST /api/quizzes` and `PATCH /api/quizzes/<id>` accept
  `game_plan_week_id: int|null`; non-null resolved via `_get_org_week`
  (404 cross-org). `GET /api/quizzes/<id>` and `GET /api/quizzes` include
  `game_plan_week`.
- No new endpoint; the week's quizzes are read inside `GET /weeks/<id>`
  (`Quiz.query.filter_by(game_plan_week_id=…)` restricted to
  `own_quizzes_query(coach)` **union** quizzes the caller may see as admin;
  in practice: the quizzes visible to the caller under `get_visible_quiz`
  rules, computed in SQL as `coach_id == coach.id OR coach.is_admin()`).

### 21.6 Motion Lab (existing, called from the client)
`GET /api/motion-lab/plays`, `GET /api/folders?area=motion`,
`POST /api/motion-lab/plays`, `POST /api/motion-lab/plays/<id>/copy`.
No changes.

### 21.7 Concepts (one addition, optional in V1)
`GET /api/concepts/<id>/weeks` → `[{week_id, label, opponent}]` for the
"Also taught in" hint. Read only; org scoped. Ships in GP-7 if at all.

## 22. Frontend component map

New (all under `frontend/src/`):
| File | Role |
|---|---|
| `api/gamePlan.ts` | types (`Week`, `Point`, `Item`, `Tips`, `TipsBlock`, `WeekDetail`, `CurrentWeek`) and functions `listWeeks, createWeek, getWeek, updateWeek, deleteWeek, getCurrentWeek, createPoint, updatePoint, reorderPoints, deletePoint, addItems, updateItem, reorderItems, deleteItem, getTips, createTips, saveTips, resetTips, exportTipsPdf(weekId, blocks, pictures: Map<string, Blob>)` |
| `game-plan/gamePlanAccess.ts` | `mayUseGamePlan(coach) = mayUseMotionLab(coach)` |
| `game-plan/GamePlanRoute.tsx` | `GamePlanGate` (copy of `MotionLabGate`) + lazy routes |
| `game-plan/GamePlanPage.tsx` + `.module.css` | landing (§9) |
| `game-plan/WeekPage.tsx` + `.module.css` | workspace (§10) |
| `game-plan/PointRow.tsx` | point row, expanded strip, forms |
| `game-plan/ItemCard.tsx` | play / note / removed cards, menus |
| `game-plan/MotionPlayPicker.tsx` | multi-select picker over the Library, grouped by folder, lazy boards |
| `game-plan/ScoutingPicker.tsx` | "Add from Scouting" |
| `game-plan/AnswerPrompt.tsx` | the one-field "vs …" prompt → copy → add → navigate |
| `game-plan/TipsPage.tsx` + `.module.css` | builder (§15.3) |
| `game-plan/tipsDraft.ts` | pure functions: `draftFromWeek(detail)`, `blocksForPoint(point, items)`, `blockForItem(item)`, id generation |
| `game-plan/weekState.ts` | pure: current-week rule (client mirror for grouping), tips/quiz state words, last-touched formatting |
| `pages/ThisWeekCard.tsx` + `.module.css` | Home card (§17) |
| `pages/quiz-editor/FromThisWeekPanel.tsx` | the panel (§16.2) |
| `components/ui/ConceptPicker.tsx` | extracted from `QuestionEditor.tsx:180–239, 560–642`; props `{value, onChange, initialConcept?, groups?: {label, ids}[]}`; `QuestionEditor` switches to it in the same slice with its existing tests green |
| `motion-lab/view/readOnlyBoard.ts`, `PlayBoard.tsx`, `playRaster.ts` | GP-0b (§4): derivation promoted from test scaffolding, the read-only component, SVG→PNG |

Modified:
| File | Change |
|---|---|
| `App.tsx` | three routes inside `NotebookLayout`, wrapped in `GamePlanGate` |
| `components/notebook/sections.ts` | Game Plan entry first, `visibleTo: mayUseGamePlan`, `phone: false` |
| `components/notebook/SectionBar.tsx` | skip `phone: false` links |
| `components/notebook/NotebookHeader.tsx` | account-menu `MenuLink` "Game Plan" |
| `components/ui/Icon.tsx` | add `clipboard` (lucide `ClipboardList`) for the section |
| `pages/DashboardPage.tsx` | render `<ThisWeekCard />` at L270 |
| `pages/quiz-editor/QuizEditorPage.tsx` + `.module.css` | week chip in `titleRow`, Unlink action |
| `pages/quiz-editor/QuestionEditor.tsx` | `ConceptPicker` swap; "From this week" button + panel slot; `<optgroup>` grouping; accepts `week?: WeekDetail` prop |
| `pages/quiz-editor/QuestionsTab.tsx` | loads the week once when `quiz.game_plan_week` is set, passes it down |
| `api/quizzes.ts`, `api/types.ts` | `game_plan_week_id` on create/update inputs; `game_plan_week` on `Quiz` |
| `motion-lab/MotionLabEditorPage.tsx` | `returnTo` param (§4) |
| `help/registry.tsx`, `help/whatsNew/releases.ts`, `help/tour/tourSteps.ts` | optional: a `pending` help entry, a release note, a tour step on `[data-tour="game-plan"]` |

Reused as is: `MenuButton/MenuItem/MenuLink`, `EmptyState`,
`LoadingState`, `ErrorBanner`, `useConfirmDialog`, `Modal` (for the
answer prompt and pickers on desktop), `nb` classes, `resolveMediaUrl`
(not needed: boards are inline SVG), `api/motionLab.ts`,
`api/concepts.ts`, `PlaybookPicker`'s layout conventions.

CSS: tokens only, no dark fallbacks, no `rgba(255,255,255,…)`; boards
render inside `.motion-lab-root` so Motion Lab's own CSS variables apply.

## 23. Empty, error and loading states

| Surface | Loading | Empty | Error |
|---|---|---|---|
| Landing | `LoadingState label="Loading your Game Plan"` | `EmptyState` "**Start the week.** A week holds who you play, what they do, what we must know, and what you teach it with." action `+ New week` | `ErrorBanner` above the list |
| Week page | `LoadingState` | (never empty as a page) | unknown id: panel "This week isn't in your Game Plan" + "Open Game Plan"; other errors: `ErrorBanner` |
| Scouting | — | "**What do they do?** Add their plays from Motion Lab, draw a new one, or jot a tendency." + `Add ▾` | inline `ErrorBanner` after a failed add |
| Points | — | "**What must we know this week?** Name it the way you'd say it in the meeting. Tie it to a concept so Saturday's questions count toward it." + gold `+ Point of emphasis` | — |
| Point with no items | — | "**Teach it with something.** A play from Motion Lab, an answer to one of their plays, or a reminder." + `Add ▾` | — |
| Motion Lab picker | `LoadingState` | "**No plays yet.** Draw the first one in Motion Lab; it will be here to add." + `Open Motion Lab` | `ErrorBanner` in the picker; Motion Lab 404 (gate) shows "Motion Lab isn't available for your account yet." |
| Tips, not started (chip) | — | opening creates the draft; with no points: "**Add a point of emphasis first**, or start with a heading." + `Add heading` | — |
| Tips builder | `LoadingState` | (draft has blocks) | save failure banner, state kept; export failure toast "Couldn't build the PDF. Try again." |
| Quiz chip menu | — | Build the quiz · Link an existing quiz… (empty own list: "No quizzes yet") | `ErrorBanner` on the week page |
| From this week panel | `LoadingState variant="inline"` | "**Nothing to pull in yet.** Plays added to the week will appear here as visuals." | inline error, panel stays open |
| Home card | renders nothing until loaded | renders nothing when `null` | renders nothing on error |
| Play removed card | — | "Play removed from Motion Lab" | — |

## 24. Regression contract

Must not break, and the check that proves it:

| Area | Protection |
|---|---|
| Quiz creation/editing | existing `tests/test_quizzes.py`, `test_questions*.py`; new tests assert a quiz with `game_plan_week_id` NULL serialises `game_plan_week: null` and PATCH without the field leaves it untouched |
| Quizzes without a week | frontend `QuizEditorPage.test.tsx` / `QuestionEditor` tests unchanged; new test: no "From this week" button and no chip when `game_plan_week` is null |
| Concept behaviour | `tests/test_concepts_and_lineage.py` unchanged (`RENAMING_A_CONCEPT_DOES_NOT_REWRITE…`); new: creating a point never creates a concept; `ConceptPicker` extraction keeps every existing `QuestionEditor` concept test green |
| Results | `tests/test_grading*.py`, `test_export_detailed_layout.py` (theme tests extended, not weakened) |
| Retest | `tests/test_retest*.py`; new: retest inherits `game_plan_week_id` |
| Motion Lab Library / authoring / autosave / folders | `tests/test_motion_lab.py` (40 tests) untouched; frontend `motion-lab/*.test.tsx` untouched except `MotionLabEditorPage.test.tsx` gaining `returnTo` cases (same-origin `/game-plan/` path honoured, anything else ignored); `overheadMarkup.test.tsx` / `OverheadBoard.test.tsx` snapshots unchanged after the `derive` promotion |
| Player quiz experience | `tests/test_play*.py`, frontend `pages/play/*` untouched; the raster image is an ordinary `question_images` row |
| Competition | untouched; `tests/test_competition*.py` |
| Player PIN security | untouched; `tests/test_player_enforcement.py` |
| Organization isolation | new `tests/test_game_plan.py::TestOrganizationBoundary`: every Game Plan route 404s for a `register_coach` rival on weeks, points, items, tips, export; `organization_merge` test extended for the four tables |
| PDF/export elsewhere | `test_no_hardcoded_reportlab_color_tokens_outside_the_theme_dict` still passes with `game_plan_export.py` included in its source scan (extend the test to scan both modules) |
| Dashboard | `DashboardPage.test.tsx`: card absent when `getCurrentWeek` resolves null or rejects; rail and Live now order unchanged |
| Navigation | `NotebookHeader`/`SectionBar` tests: bottom bar still exactly three links; desktop shows Game Plan only for `mayUseGamePlan` |
| Type and test gates | `npm run build` and `npm run test:ci` (sequential guard) and `pytest -q` green after every slice |

## 25. Implementation slices

Order chosen so that each slice is deployable alone, the riskiest
cross-cutting pieces (migration head, Motion Lab touches) come first and
small, and the quiz link comes last.

**GP-0a · Migration head** — *Precondition.* Rebase P2's
`b3e8d51f7a26` onto master's head (or add a merge revision) as part of
the P2 merge. Result: `flask db heads` prints one head. Tests: full backend
suite on the merged tree. Not included: any Game Plan code.

**GP-0b · Read-only play board and raster (Motion Lab side, minimal)**
- Frontend: `motion-lab/view/readOnlyBoard.ts` (`deriveForBoard` promoted
  from `__characterization__/capture.ts`), `PlayBoard.tsx`,
  `playRaster.ts` (`renderPlayToPng`), `MotionLabEditorPage` `returnTo`.
- Tests: `PlayBoard.test.tsx` renders the same SVG as
  `OverheadBoard.test.tsx` for the fixture play; `playRaster.test.ts`
  produces a PNG blob of the requested width (jsdom canvas stub allowed;
  a real-browser check is listed in the manual checklist);
  `MotionLabEditorPage.test.tsx` `returnTo` cases.
- Migration: none. Depends on: P2 merged. Not included: thumbnails in the
  Library, any snapshot storage.

**GP-1 · Weeks and points (with notes)**
- Backend: migration 1 (§20); models `GamePlanWeek`, `GamePlanPoint`,
  `GamePlanItem` (note kind only exercised), `GamePlanTips` (table
  created, unused); routes §21.1–21.3 for weeks, points, note items;
  `require_game_plan_coach`; registry updates.
- Frontend: `api/gamePlan.ts`, gate, routes, `GamePlanPage`, `WeekPage`
  with Scouting (notes) and points, `ConceptPicker` extraction,
  `sections.ts`/`SectionBar`/`NotebookHeader` changes, `Icon` addition,
  empty states.
- Tests: `tests/test_game_plan.py` (create/list/detail/patch/delete;
  points CRUD + reorder permutation rule; note items add/move/reorder/
  delete; org boundary; concept must be in org; point delete moves items
  to Scouting); frontend `GamePlanPage.test.tsx`, `WeekPage.test.tsx`,
  `ConceptPicker.test.tsx`, `QuestionEditor` suite green.
- Migration: yes (1). Depends on: GP-0a. Not included: plays, answers,
  tips, quiz link, Home card.
- User-visible: create a week, add points and notes, reorder, on desktop
  under the gate.

**GP-2 · Plays from the Library**
- Backend: play-kind items (`play_id`, `play_name`, `caption`), embedded
  `play` in responses, `already_in_week` rule, `selectinload`.
- Frontend: `MotionPlayPicker`, `ItemCard` play/removed variants with
  `PlayBoard`, New play in Motion Lab (create + add + navigate with
  `returnTo`), Open, caption edit, `motionLab.css` import on the week page.
- Tests: backend play items (cross-org play 404, duplicate 422, play
  deleted → `play_id` NULL and detail still 200 with `play_name`);
  frontend picker (lazy render, multi-select, disabled in-week rows),
  card menu actions each → one API call.
- Migration: none. Depends on: GP-0b, GP-1. Not included: answers.

**GP-3 · Answers**
- Backend: `source_play_id` accepted on add; detail exposes it; no new
  routes.
- Frontend: `AnswerPrompt` (copy via `copyMotionPlay` with name, no
  folder), nesting under source cards, "Answer to a scouted play…" from a
  point, confirm text when removing a source with answers.
- Tests: backend `source_play_id` cross-org 404, SET NULL on source delete
  (answers un-nest, detail 200); frontend: Add an answer issues exactly
  `copyMotionPlay(sourceId, {name: 'Trips Rt — Mesh vs Cover 7'})` then
  `addItems` with `source_play_id` then navigates with `returnTo`.
- Migration: none. Depends on: GP-2.

**GP-4 · Tips & Reminders**
- Backend: tips routes §21.4, schema, `tipsDraft` server-side generation
  (§15.2), `services/game_plan_export.py`, export route with multipart
  pictures, theme keys, `exported_at`.
- Frontend: `TipsPage`, `tipsDraft.ts` (client mirror used for "Add
  point"/"Add"), debounced save, Preview, Export with client rasters.
- Tests: backend draft generation is deterministic for a fixture week
  (order, skipped removed plays, note formatting), PUT validation (limits,
  duplicate ids, foreign play), export builds a PDF with and without
  pictures, missing picture prints the placeholder, colour test extended;
  frontend builder operations (add point → blocks, reorder, delete, inline
  edit → one PUT after debounce), export → one multipart call with one
  file per picture block.
- Migration: none (table from GP-1). Depends on: GP-2 (pictures), GP-0b
  (raster). Not included: player delivery, playbook pages.

**GP-5 · Quiz link and From this week**
- Backend: migration 2; `game_plan_week_id` in quiz schemas/routes/`to_dict`;
  retest inheritance; week detail lists quizzes.
- Frontend: week chip + Build/Link/Unlink; `QuizEditorPage` chip;
  `QuestionEditor` "From this week" button and `FromThisWeekPanel` (Use
  concept, Use as visual via `renderPlayToPng` → `acceptImage`, Copy);
  concept `<optgroup>`s; `QuestionsTab` loads the week.
- Tests: backend link/unlink (cross-org week 404, member cannot link a
  teammate's quiz, admin can), retest inherits; frontend panel actions
  (Use as visual calls `acceptImage` with a PNG File and sets the concept
  only when empty; Use concept disabled on "No concept"; Copy writes the
  clipboard; no button without a week).
- Migration: yes (2). Depends on: GP-2, GP-0b.

**GP-6 · Home card and mobile entry**
- Backend: `GET /current` (§21.6).
- Frontend: `ThisWeekCard` at `DashboardPage` L270; account-menu entry;
  phone flag on the section link.
- Tests: card renders for a current week, absent for null/error/ungated;
  dashboard order unchanged; `SectionBar` still three links.
- Migration: none. Depends on: GP-1 (GP-4/5 improve the state words).

**GP-7 · Polish and optional**
- "Also taught in" (`GET /concepts/<id>/weeks`), help entry, release
  note, tour step, 375 px pass on the week page, manual checklist entries
  (real-browser raster, PDF in Acrobat and Preview).

Each slice ends with `pytest -q`, `npm run build`, `npm run test:ci`, and
a summary; commits wait for approval (CLAUDE.md conventions).

## 26. V1 exclusions

Not in V1, and not to be added during implementation:
page items · image items · video/clips · player delivery of Tips ·
Results by week or by point · opponent library/record · calendar or
day scheduling · task management, statuses, assignees · taught counters
· scouting analytics · tendency percentages · Game Plan-specific play
storage or snapshot storage · automatic question generation · live
inheritance between source and answer · global Concept rename · concept
archive/delete endpoints (Phase B) · Start from a past week · labels and
units on items/points · coverage numbers on the quiz chip · a Motion Lab
summary endpoint · Library thumbnails · a fourth phone destination ·
search · pagination · a Motion Lab visual-source type on questions ·
revision conflicts on tips.

## 27. Open engineering questions

1. **Migration head** (§20): rebase `b3e8d51f7a26` onto `f1a6c27b90d4`
   or add a merge revision? Recommendation: rebase (edit `down_revision`)
   during the P2 merge, since P2 is not deployed.
2. **Picker cost**: `GET /api/motion-lab/plays` inlines every document.
   Fine for pilot sizes; if a library exceeds ~200 plays, add
   `?summary=1` on the Motion Lab side (drop `document`) and have the
   picker fetch documents on demand. Not required for V1.
3. **Tips concurrency**: no `revision` on `game_plan_tips`; two coaches
   editing the same sheet overwrite each other silently. Acceptable for
   V1 (rare, low stakes); adding `base_revision` later mirrors Motion Lab.
4. **"Today" for the current-week rule**: server UTC date vs the
   coach's local date. Recommendation: the client sends `?today=YYYY-MM-DD`
   to `GET /current` and `GET /weeks` grouping is client-side; the server
   defaults to UTC when absent.
5. **SVG → PNG fidelity**: inline computed styles are required because
   the board's colours come from CSS custom properties on
   `.motion-lab-root`; verify on Chrome, Safari and Firefox in GP-0b
   before GP-4 relies on it. Fallback in the PDF is specified
   ("Diagram unavailable"), so a raster failure never fails an export.
6. **Week visibility of quizzes**: the week lists quizzes the caller can
   see under `get_visible_quiz` rules; a member sees a teammate's linked
   quiz only by title? Recommendation: list all linked quizzes by title
   and state (the week is org-shared), but link only those the caller may
   open; others render as plain text with "created by {username}".

## 28. Product decisions that genuinely still require owner input

1. **Gate coupling.** Game Plan V1 is gated with Motion Lab (platform
   owner during the pilot) and opens with it. Confirm, or decide that
   Motion Lab opens to all coaches before Game Plan ships.
2. **Section order.** Game Plan as the first desktop section (before
   Quizzes). Confirm.
3. **Quiz created from a week** goes to Uncategorized (no folder) with
   title "{opponent} · {label}". Confirm, or specify a folder rule.
4. **Answer naming** is `"{source} vs {label}"` with the label typed by
   the coach. Confirm.
5. **Tips prefill includes every point and excludes Scouting** (owner
   decision 3 says "from the week's Points of Emphasis"; Scouting is
   excluded by that reading). Confirm.
6. **PDF filename** `{opponent}-{label}-tips.pdf`. Confirm.
7. **Week-level quiz listing for members** (§27 Q6). Choose.
