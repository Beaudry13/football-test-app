# Football Quiz Platform

A quiz/test platform for football coaches to build, administer, and grade
pre-game and practice quizzes — with a built-in image annotation tool for
drawing routes, circling players, and highlighting on film stills.

This repo currently contains **Phase 1: the backend** (PostgreSQL schema +
Flask REST API). The React frontend, including the drawing tool, is Phase 2
and will be built on top of this API.

## Stack

- **Backend:** Python + Flask, JWT auth, RESTful API
- **Database:** PostgreSQL, migrations via Flask-Migrate/Alembic
- **File storage:** local disk in dev, behind a swappable interface for
  cloud storage in production

See [`docs/API.md`](docs/API.md) for the full endpoint reference.

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

## Running tests

Tests run against a real Postgres database (set `TEST_DATABASE_URL` in
`backend/.env`, or rely on the default pointing at a `football_quiz_test`
database). Each test runs in a rolled-back transaction, so the schema only
needs to exist once.

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
