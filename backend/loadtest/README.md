# Load testing: realistic player-flow simulation

Simulates the actual public player flow (not just hammering the homepage):
join a quiz by code, pick/enter a name, read and answer every question with
realistic think-time between them, submit, and check results - exactly the
sequence a real player's browser drives via `frontend/src/pages/play/*`.

**Everything here targets a disposable local database. Nothing in this
directory ever touches Render or Netlify.** `seed.py` refuses to run unless
`DATABASE_URL` contains `loadtest` in the database name, specifically to
make it hard to point this at the wrong database by accident.

## What gets tested

Endpoints exercised, matching `backend/app/routes/play.py`:

1. `POST /api/play/validate-code` - load the quiz (join screen)
2. `POST /api/play/start` - identify as a specific roster player, create/resume the attempt
3. `POST /api/play/answers` - one autosave call per question, with think-time between (matches `QuizStep.tsx`'s autosave-per-answer behavior)
4. `POST /api/play/submit` - final submission
5. `POST /api/play/results` - confirm the player can read back their own graded state

Each virtual player uses a unique, pre-seeded roster name (`LoadPlayer0001`,
`LoadPlayer0002`, ...) so post-run verification can check every single one
individually for a missing, duplicate, or cross-associated submission.

## One-time setup

From `backend/`, with the venv active:

```bash
pip install -r requirements.txt
pip install waitress locust
```

(`waitress` stands in for `gunicorn` - gunicorn doesn't run on Windows at
all, since it depends on `fcntl`/`os.fork`. Waitress is a real multi-threaded
production-grade WSGI server, so this is a legitimate substitute for local
testing, but it is a different process/concurrency model than gunicorn - see
"Known limitations of this local rig" below.)

## Every run: 4 steps

### 1. Create/reset the disposable database

```bash
python loadtest/setup_db.py
```

Drops and recreates `football_quiz_loadtest`, then runs every real
migration against it (`flask db upgrade`) so the schema exactly matches
production - not `db.create_all()`, which can silently diverge from the
migration history over time.

### 2. Seed test data

```bash
python loadtest/seed.py --players 100
```

Creates one throwaway coach/organization, one quiz with 5 auto-graded
questions (true/false + multiple-choice only - deliberately no `written`
questions, since those need manual grading and have no deterministic
`is_correct` to verify against), a roster of `--players` uniquely-named
players (seed enough for your largest planned stage; reseeding is cheap),
and one active access code. Writes `loadtest_config.json` (gitignored) with
everything `locustfile.py` and `verify.py` need: the access code, quiz id,
question/answer key, and the player name pool.

### 3. Start the server under test

```bash
set FLASK_ENV=production
set SECRET_KEY=loadtest-only-not-a-real-secret-abc123
set JWT_SECRET_KEY=loadtest-only-not-a-real-secret-xyz789
set DATABASE_URL=postgresql://quiz_user:quiz_password@localhost:5432/football_quiz_loadtest
set PORT=5055
waitress-serve --host=0.0.0.0 --port=5055 wsgi:app
```

(PowerShell: use `$env:FLASK_ENV = "production"` etc. instead of `set`.)

`FLASK_ENV=production` deliberately runs the **real** `ProductionConfig`
path - including the PEIRA-002/003 startup validation and, importantly,
**rate limiting enabled** (`TestingConfig` disables it; production doesn't).
This matters: every virtual player in a Locust run shares one source IP
(`127.0.0.1`), which is a faithful proxy for the realistic scenario of an
entire team joining from one shared field/gym/locker-room WiFi network -
see the PEIRA-005 finding below, which this exact setup surfaced.

### 4. Run a load stage

```bash
cd loadtest
locust -f locustfile.py --headless -u 5  -r 2  -t 90s --csv=results/stage_5  --host=http://127.0.0.1:5055
locust -f locustfile.py --headless -u 25 -r 5  -t 90s --csv=results/stage_25 --host=http://127.0.0.1:5055
locust -f locustfile.py --headless -u 50 -r 10 -t 90s --csv=results/stage_50 --host=http://127.0.0.1:5055
```

**Use `127.0.0.1`, not `localhost`, in `--host` on Windows.** Locust runs
under gevent, and gevent's DNS resolver has a well-documented ~2 second
per-connection stall resolving `localhost` on Windows specifically (confirmed
during this rig's own smoke test: raw `curl` hit the same endpoint in
~240ms while Locust-via-`localhost` reported ~2100ms on every request -
switching to the literal `127.0.0.1` made the artifact disappear entirely).
This is a Windows/gevent quirk, not a backend performance issue.

`-u` = concurrent virtual players, `-r` = spawn rate (players/sec, so a
"the whole team clicks the link within ~10 seconds" ramp, not everyone at
the exact same instant), `-t` = hard stop after this long (each player's
full scripted flow finishes in ~15-30s including think-time, so 90s is
generous headroom, not a target duration).

**The prepared-but-not-run 100-player stage** (do not run this
automatically - only run it after 5/25/50 all pass their thresholds):

```bash
python loadtest/seed.py --players 100   # if not already seeded at >=100
cd loadtest
locust -f locustfile.py --headless -u 100 -r 15 -t 120s --csv=results/stage_100 --host=http://localhost:5055
```

### 5. Verify data integrity (run after every stage)

```bash
python loadtest/verify.py --expected 50
```

(`--expected` = the `-u` value from the stage you just ran.) Connects
directly to `football_quiz_loadtest` and checks, independent of anything
Locust itself reported:

- **Lost submissions**: every seeded player name that should have submitted actually has a `SUBMITTED` attempt row.
- **Duplicate results**: no player has more than one attempt row for the access code (the DB unique constraint should make this structurally impossible, not just unlikely - this is what proves that constraint held under real concurrent load, not just in a single-threaded pytest).
- **Cross-player association**: every answer row's `attempt_id` belongs to the attempt whose `player_name` matches the expected player for that answer's content (a stale/reused connection or a session-handling bug would show up here).
- **Incorrect scoring**: recomputes expected `is_correct` from the seeded answer key and compares to what's actually stored.
- **Server/DB errors**: cross-checked against Locust's own CSV failure log.

Prints a pass/fail summary; exits non-zero on any integrity failure.

### Cleanup

```bash
python loadtest/setup_db.py --drop-only
```

Drops `football_quiz_loadtest` entirely. Safe to skip between runs (step 1
recreates it from scratch anyway) - only needed if you want to reclaim disk
space when you're done testing for the night.

## Known limitations of this local rig

- **Waitress, not gunicorn.** Gunicorn can't run on Windows at all. Waitress
  is a real threaded WSGI server (not Flask's single-threaded dev server),
  so this is a meaningful concurrency test, but its threading model isn't
  identical to gunicorn's worker-process model. Treat absolute throughput
  numbers as directional, not as a literal prediction of Render's Starter
  plan capacity - but data-integrity results (lost/duplicate/cross-
  associated submissions) are just as valid locally as they would be
  against gunicorn, since that's a database/application-logic question, not
  a WSGI-server question.
- **Single-worker gunicorn on Render today.** Separately from this rig: the
  actual `Dockerfile` CMD (`gunicorn --bind 0.0.0.0:${PORT:-5000} wsgi:app`)
  doesn't specify a worker count, so gunicorn defaults to **one single
  synchronous worker**. That's a real, separate finding - see PEIRA-006.
- **One machine, one network hop.** No real internet latency, no real
  mobile-network jitter/packet loss. This rig proves the application and
  database handle N concurrent full quiz-taking sessions correctly and
  measures relative response-time growth as load increases; it is not a
  substitute for testing against the actual deployed Render/Netlify stack
  before Tuesday if you want real-world latency numbers.
