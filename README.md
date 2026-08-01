# Football Quiz Platform

A quiz/test platform for football coaches to build, administer, and grade
pre-game and practice quizzes — with a built-in image annotation tool for
drawing routes, circling players, and highlighting on film stills.

This repo contains both phases: **Phase 1**, a PostgreSQL + Flask REST API,
and **Phase 2**, a React/TypeScript frontend (coach quiz builder + drawing
tool, and the public player flow) that talks to it.

## Stack

- **Backend:** Python + Flask, JWT auth, RESTful API
- **Frontend:** React + TypeScript (Vite), Fabric.js for the annotation canvas
- **Database:** PostgreSQL, migrations via Flask-Migrate/Alembic
- **File storage:** local disk in dev, behind a swappable interface for
  cloud storage in production

See [`docs/API.md`](docs/API.md) for the full endpoint reference and
[`frontend/README.md`](frontend/README.md) for frontend-specific details.

## Project layout

```
backend/
  app/
    models/       SQLAlchemy models
    routes/        Flask blueprints (one per resource area)
    schemas/       marshmallow request-validation schemas
    services/       file storage, access code generation, CSV parsing
    utils/          auth helpers, request validation helpers
    config.py       environment-based configuration
    extensions.py   shared Flask extension instances
    errors.py       centralized error handling
  migrations/       Alembic migration scripts
  tests/            pytest suite
  wsgi.py           app entrypoint
frontend/
  src/
    api/            typed request functions + response types
    auth/           JWT auth context, protected routes
    components/     shared UI + the Fabric.js annotation tool
    pages/          coach quiz-builder screens and the public player flow
docs/
  API.md            endpoint reference
docker-compose.yml  Postgres + backend for local development
```

## Running locally

### Option A: Docker Compose

```bash
docker compose up --build
```

This starts Postgres and the Flask backend. On first run, apply migrations:

```bash
docker compose exec backend flask db upgrade
```

The API is then available at `http://localhost:5000/api`.

### Option B: Native Python + Postgres

1. Create a Postgres database and copy `backend/.env.example` to
   `backend/.env`, filling in `DATABASE_URL`.
2. Install dependencies and apply migrations:

   ```bash
   cd backend
   python -m venv .venv
   .venv/Scripts/activate   # or source .venv/bin/activate on macOS/Linux
   pip install -r requirements.txt
   flask db upgrade
   ```
3. Run the dev server:

   ```bash
   flask run
   ```

### Frontend

```bash
cd frontend
cp .env.example .env   # point VITE_API_URL at the backend above
npm install
npm run dev
```

The backend's `CORS_ORIGINS` (in `backend/.env`) must list the frontend's
origin — include both `http://localhost:5173` and `http://127.0.0.1:5173`,
since browsers treat them as different origins.

## Running tests

Backend tests run against a real Postgres database (set `TEST_DATABASE_URL`
in `backend/.env`, or rely on the default pointing at a
`football_quiz_test` database). Each test's rows are truncated after it
runs, so the schema only needs to exist once per session.

```bash
cd backend
flask db upgrade  # against the DATABASE_URL configured for tests, if needed
pytest
```

## Deployment notes

The backend has no vendor lock-in: it's a standard Flask app that runs
behind gunicorn (see `backend/Dockerfile`) and talks to any PostgreSQL
instance via `DATABASE_URL`. It's designed to deploy cleanly to Railway,
Render, Fly.io, or similar. File storage is behind a `FileStorage`
interface (`app/services/file_storage.py`) so local disk can be swapped for
S3-compatible storage without touching route code.

The frontend is a static build (`npm run build` in `frontend/`) with no
server dependency beyond `VITE_API_URL`, so it deploys cleanly to Netlify,
Vercel, or any static host — set `VITE_API_URL` to the deployed backend's
URL at build time and add the frontend's deployed origin to the backend's
`CORS_ORIGINS`.
