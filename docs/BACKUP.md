# Manual database backups

This is a manual, run-it-yourself procedure — **nothing in this repo
automates or schedules it**. This stack has no cron/scheduled-job
infrastructure, so there is no "set it and forget it" option here short of
upgrading the Render Postgres plan (see the Backups section in
[`DEPLOYMENT.md`](DEPLOYMENT.md)), which is the real fix. Treat this as a
stopgap for the free tier, not a substitute for that.

## Taking a backup

You need `pg_dump` (ships with a local PostgreSQL install) and the
production database's connection string. On Render, find it under the
`football-quiz-db` database's **Connect** tab — use the **External
Connection String** (the internal one only works from inside Render's
network).

```bash
pg_dump "postgresql://<user>:<password>@<host>/<database>" -Fc -f "backup-$(date +%Y%m%d).dump"
```

`-Fc` uses Postgres's custom compressed format — smaller than plain SQL, and
required for the `pg_restore` command below (not `psql`). Store the
resulting `.dump` file somewhere durable and *not* in this git repo (it
contains real player names and grading data) — a private cloud storage
bucket or encrypted local drive, not a laptop desktop.

## Restoring from a backup

Restoring **overwrites the target database's contents** — never run this
against a database you don't intend to replace. Sanity-check which
connection string you're pointing at before running it.

```bash
pg_restore --clean --if-exists -d "postgresql://<user>:<password>@<host>/<database>" backup-20260731.dump
```

`--clean --if-exists` drops existing objects before recreating them, so the
restored database matches the dump exactly rather than merging with
whatever was already there.

## How often to actually do this

There's no enforcement mechanism here — it's only as good as your own
discipline about running it. A reasonable cadence for a small team is
weekly, or before/after anything that touches a lot of data at once (a
season's worth of quizzes, a roster import). If that's more manual upkeep
than you want to commit to, upgrading the Render Postgres plan for real
automated backups (see `DEPLOYMENT.md`) is the better long-term answer.
