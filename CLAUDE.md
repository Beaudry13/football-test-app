# Peira — working notes for Claude Code

Peira is a multi-tenant football-quiz coaching platform. Coaches build
quizzes from film stills, players take them on their phones with an access
code, coaches grade written answers by hand and export results as PDF/CSV.

This file is read automatically at the start of every session. It exists so
a fresh session on any machine can get running quickly and avoid the traps
that are not obvious from the code.

---

## Stack

| | |
|---|---|
| Backend | Python 3.12, Flask, SQLAlchemy, Alembic (Flask-Migrate), PostgreSQL |
| Frontend | React 19, TypeScript, Vite, React Router, Fabric.js v7 |
| Tests | pytest (backend), Vitest + React Testing Library (frontend) |
| Lint | oxlint |
| Storage | local disk in dev, Cloudflare R2 (S3-compatible) in production |
| PDFs | ReportLab |
| Hosting | Render (backend + Postgres), Netlify (frontend) |

Versions verified working: Node 24.18.1, npm 11.16.0, Python 3.12.10.

---

## Getting running on a new machine

### The fast path — frontend only

**Most frontend work needs no backend, no database, and no `.env`.** The
Vitest suite runs fully mocked.

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
```

Add `-- --host` to reach it from a phone on the same wifi.

### Full stack

Prerequisites: Python 3.12+, Node 20+, and a PostgreSQL 14+ instance
listening on `localhost:5432`. (Postgres is required — the code uses
`INSERT … ON CONFLICT`, native enums, and partial indexes, so SQLite is not
a substitute.) `docker-compose.yml` at the repo root will provide Postgres
if you don't want to install it.

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate            # Windows;  source .venv/bin/activate elsewhere
pip install -r requirements.txt
cp .env.example .env              # then edit DATABASE_URL to match your Postgres
flask db upgrade                  # create/upgrade the schema
flask run                         # http://localhost:5000/api
```

`backend/.env` is **gitignored** — it does not travel with the repo. Copy
`.env.example` and fill it in per machine. Dev fallbacks exist for
`SECRET_KEY`/`JWT_SECRET_KEY`, so the only value you normally must set is
`DATABASE_URL`.

The dev database itself never travels either. A new machine starts with an
empty schema; register a coach through the UI to get going.

### Preview servers

`.claude/launch.json` defines `frontend` (5173) and `backend` (5000) for the
Browser-pane preview tools. Prefer `preview_start` over running dev servers
through Bash.

---

## Commands

```bash
# Frontend
cd frontend
npx vitest run --no-file-parallelism   # see the note below — use this form
npx tsc --noEmit
npx oxlint .
npx vite build

# Backend
cd backend
.venv/Scripts/python.exe -m pytest -q
```

### Test-suite noise that is NOT your fault

Both of these predate any given session. Do not "fix" them and do not report
them as regressions:

- **Frontend: run with `--no-file-parallelism`.** Under default parallelism
  2–5 files (`AnnotationCanvas`, `shapeFactories`, sometimes `LoginPage`/
  `JoinOrgPage`/`FolderPage`) fail from host-load timing. Each passes in
  isolation; sequential gives a clean run.
- **Vitest exits non-zero with ~6 "unhandled errors" while every test
  passes.** These are jsdom limitations — `Image given has not completed
  loading` from canvas `drawImage`, and `scrollIntoView is not a function`.
  Verified identical on `master`, and the count varies run to run.
- **oxlint reports 2 warnings** (`AuthContext` fast-refresh, an
  `AnnotationCanvas.test` this-alias). Both pre-existing.

---

## Layout

```
backend/app/
  models/          SQLAlchemy models
  routes/          Flask blueprints (auth, quizzes, questions, play, grading, …)
  services/        business logic — export.py, attempts.py, player_analytics.py,
                   file_storage.py, player_names.py
  assets/          shipped non-code assets (the Peira mark used in PDFs)
backend/migrations/versions/   Alembic revisions
backend/tests/                 pytest

frontend/src/
  api/             typed client + request wrapper
  auth/            AuthContext, ProtectedRoute
  components/      shared UI; ui/ holds the design-system primitives
  components/annotation/   Fabric-based coach annotation editor
  pages/           route components
  styles/          tokens.css (canonical) + notebook.module.css (coach theme)

docs/            DEPLOYMENT.md, THEMING.md, API.md, DESIGN-draw-on-image.md
```

---

## Things that will bite you

These are all real bugs that already happened here. They are the reason this
file exists.

**1. CSS custom-property collisions are global and silent.**
`styles/tokens.css` (coach, dark) and `index.css` (player, light) are two
`:root` blocks. Two `:root`s declaring the same property name is not scoped —
load order wins everywhere, and coach pages silently render with the player
palette. Colliding names therefore take a `--peira-` prefix. Read the NAMING
NOTE at the top of `tokens.css` before adding any token.

**2. The coach theme is dark, the player theme is light, and that is
deliberate.** Never "unify" them. See `docs/THEMING.md`.

**3. Canvas coordinate space is pinned per image and must never shift.**
`question_images.canvas_width` records the space annotations were authored
in. Changing the default width would move every previously-saved shape on
every existing question. `canvasSizing.ts` explains the rule; respect the
distinction it draws between *coordinate space* and *render scale*.

**4. The grading vocabulary is shared and must not diverge.**
CORRECT / INCORRECT / NOT_GRADED / UNANSWERED, and
`score = correct / (correct + incorrect)` — never counting ungraded or
unanswered, never fabricating 0% when nothing is graded. Defined identically
in `services/export.py` and `services/player_analytics.py`. If you change one
you must change both, or the PDF, the CSV, the Results tab and the analytics
page start disagreeing with each other.

**5. PDF styling is a theme dict, not literals.** Every builder in
`services/export.py` takes `theme: dict | None = None`. There is a test that
fails if a bare `colors.X` appears outside `PDF_THEME`. Restyling means
constructing a different dict.

**6. Player answers autosave through an upsert.** `services/attempts.py`
uses `INSERT … ON CONFLICT DO UPDATE` because a debounce timer and a fresh
click genuinely race. Don't replace it with check-then-insert.

**7. Every mutating `/play` route re-derives the attempt** from
`(access_code_id, player_name/player_id)` rather than trusting a
client-supplied id. Keep that.

**8. Adding a value to a native Postgres enum needs care.**
`questiontype`, `attemptstatus`, `coachrole` are native enums storing member
*names* (`WRITTEN`, not `written`). `ALTER TYPE … ADD VALUE` cannot be used
in the same transaction that added it, and Alembic wraps migrations in one.
Split the migration, and rehearse on a scratch database first.

---

## Conventions

- **Approval is the gate, on every commit and every push.** Finish the work,
  summarise it, run lint and tests and report the *actual* results including
  failures — then wait. Do not commit or push until told to.
- **Where the work goes depends on its size.** Ordinary changes (a fix, a
  styling pass, a small feature) go straight onto `master` — the owner wants
  one linear history and reviews each change before it lands. Large
  multi-phase features that will sit unfinished for a while get their own
  branch, so `master` is never carrying half a feature.
- **Pushing `master` deploys.** It triggers Render and Netlify automatically;
  there is no separate deploy step to catch a mistake. Pushing a *feature*
  branch does not deploy and is a safe way to back work up.
- Commit messages explain *why*, not just what. Comments in this codebase
  are unusually load-bearing — they record the reasoning behind
  non-obvious choices. Match that density; don't strip them.
- Tests live beside the code (`Foo.test.tsx`, `tests/test_foo.py`).
- Prefer extending an existing service over adding a parallel one.

---

## Deployment

- **Frontend:** https://football-test-app.netlify.app
- **Backend:** https://football-quiz-backend-d2f5.onrender.com (health:
  `/api/health`, which runs `SELECT 1`, so a 200 proves the DB is reachable)
- **Repo:** https://github.com/Beaudry13/football-test-app

Pushing `master` deploys both. Render runs `flask db upgrade` as a
pre-deploy step, so a failing migration fails the deploy rather than booting
a broken app. Render posts GitHub *Deployments* (not commit statuses);
Netlify posts nothing, so confirm the frontend by fetching the site and
checking the hashed bundle.

The Netlify site name appears nowhere in the repo. If it's ever lost, it can
be recovered by probing the backend's CORS: send
`Origin: https://<candidate>.netlify.app` to `/api/health` and see which one
comes back in `access-control-allow-origin`.

---

## Work in flight

**Draw on Image** — a per-question drawing answer, Phases 0-2 complete.

- Read `docs/DESIGN-draw-on-image.md` first — product decisions are locked in
  its §10 — then `docs/DRAW_ON_IMAGE_PHASE_0.md` for the engine's design and
  the spike's findings.
- **Drawing is a per-question boolean (`questions.allow_drawing`), NOT a
  question type.** The design doc originally locked a `draw_on_image` type;
  §3.3 and §10 record why that was reversed. The enum route is a one-way door
  (Postgres cannot remove an enum value) and cannot express "multiple choice
  *and* a drawing" on one question.
- `frontend/src/components/drawing/` is the engine and must stay free of quiz
  knowledge (§11.1). Everything quiz-specific lives in
  `frontend/src/pages/play/drawingDraft.ts`.
- The Phase 0 spike harness (`frontend/src/pages/spike/`, route
  `/spike/drawing`) has been **deleted** now that the real feature exists.
  Its findings are in the Phase 0 report. Note this also removed the only
  on-screen HUD — FPS, canvas memory and stray-mark counters. Re-attaching
  one needs no engine change: `DrawingBoard` still exposes a `renderOverlay`
  render prop fed with `BoardTelemetry`.
- **Phase 3 is not built.** Drawings persist to localStorage only; nothing
  reaches `answer_drawings`, so a coach cannot see a player's drawing and the
  server's `require_all_answers` check cannot count one.
