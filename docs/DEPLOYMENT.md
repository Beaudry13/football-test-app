# Deployment guide

A concrete walkthrough for deploying to Cloudflare R2 (image storage) +
Render (backend + Postgres) + Netlify (frontend). Do these in order — each
step needs something from the one before it.

Budget about 30-45 minutes the first time through.

## 0. Push to GitHub

Both Render and Netlify deploy from a git repo, not a local folder. If this
repo isn't already on GitHub, push it there first — both platforms connect
to it in the steps below.

## 1. Cloudflare R2 (image storage)

Question images need to live somewhere that survives a redeploy — see the
"File storage" note in the root README for why local disk doesn't work here.

1. Create a free account at [cloudflare.com](https://cloudflare.com) if you
   don't have one, then go to **R2 Object Storage** in the dashboard.
2. **Create bucket** — name it e.g. `football-quiz-images`. Region: Automatic.
3. Open the bucket → **Settings** → under **Public access**, enable the
   **R2.dev subdomain**. Copy the resulting public URL
   (`https://pub-xxxxxxxx.r2.dev`) — that's `R2_PUBLIC_URL_BASE`.
4. Back in the R2 landing page, go to **Manage API tokens** → **Create API
   token**. Permissions: **Object Read & Write**, scoped to just this
   bucket. Create it, then copy the three values it shows you *once*:
   - Access Key ID → `R2_ACCESS_KEY_ID`
   - Secret Access Key → `R2_SECRET_ACCESS_KEY`
   - Your Cloudflare account ID (shown on the same page, or under **R2** →
     the URL contains it) → `R2_ACCOUNT_ID`
5. Note the bucket name too → `R2_BUCKET_NAME`.

You now have all five `R2_*` values `render.yaml` expects.

## 2. Render (backend + Postgres)

1. Create an account at [render.com](https://render.com) if needed.
2. **New** → **Blueprint** → connect your GitHub account → select this repo.
   Render finds `render.yaml` at the repo root automatically and shows you
   the two resources it defines: the `football-quiz-backend` web service
   and the `football-quiz-db` Postgres instance.
3. Click **Apply**. Render provisions the database, builds the backend from
   `backend/Dockerfile`, generates `SECRET_KEY`/`JWT_SECRET_KEY`, wires
   `DATABASE_URL` from the new database automatically, and runs
   `flask db upgrade` before starting the service (via `preDeployCommand`
   in `render.yaml`) — the schema is ready with no manual migration step.
4. The five `R2_*` variables and `CORS_ORIGINS` are marked `sync: false` in
   `render.yaml`, meaning Render won't set them for you. Go to the web
   service → **Environment** and add:
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
     `R2_BUCKET_NAME`, `R2_PUBLIC_URL_BASE` — from step 1.
   - `CORS_ORIGINS` — leave a placeholder like `http://localhost:5173` for
     now; you'll update it in step 4 once the Netlify URL exists.
5. Wait for the deploy to finish, then note the service's URL, shown at the
   top of its dashboard page — something like
   `https://football-quiz-backend.onrender.com`. **Copy the exact URL shown
   in your dashboard rather than assuming this pattern**: Render appends a
   random suffix (e.g. `-d2f5`) if the plain name is already taken, which
   it may be even on a first deploy depending on prior attempts. This
   project's actual URL is `https://football-quiz-backend-d2f5.onrender.com`
   — always check the dashboard, don't guess from the service name.
6. Verify it's actually up: open `https://football-quiz-backend-d2f5.onrender.com/api/health`
   in a browser. You should see `{"status":"ok"}`.

**Cost note:** the web service is on the Starter plan (not free) in
`render.yaml` deliberately — Render's free tier spins down after 15 minutes
of inactivity, and the first request after that (very plausibly a player
mid-quiz) would stall 30-50 seconds on a cold start.

### Backups

The Postgres instance is on Render's **free plan** in `render.yaml`. As of
this writing, that plan has **no backup guarantee at all** — no automated
snapshots, no point-in-time recovery — and the database is deleted outright
90 days after creation. Put a reminder in your calendar to upgrade it before
then, or you will lose the database entirely, not just recent changes.

This is a real gap, not a hypothetical one: once real coaches and players
are relying on this data, "the free tier will probably be fine" is not an
acceptable backup story. Two options, in order of how much this matters to
you:

1. **Upgrade the Postgres plan.** Render's paid database plans include
   automated daily backups with a retention window — confirm the current
   specifics on [Render's Postgres pricing page](https://render.com/pricing)
   before deciding, since exact retention/pricing can change. This is the
   real fix, and it's a billing decision only you can make — nothing in this
   repo can do it for you.
2. **Manual backups as a stopgap.** See [`BACKUP.md`](BACKUP.md) for a
   `pg_dump`/`pg_restore` command pair you can run yourself periodically.
   This is explicitly a manual procedure — nothing in this stack schedules
   or automates it, so it's only as good as your own discipline about
   actually running it.

**Uptime monitoring:** `GET /api/health` checks real database connectivity
(not just "is the Flask process up"), so it's a meaningful target for an
external monitor. Pointing a free service (e.g.
[UptimeRobot](https://uptimerobot.com)) at
`https://<your-render-url>/api/health` is a five-minute setup outside this
repo and means an outage gets caught proactively instead of by a coach
reporting it mid-camp.

## 3. Netlify (frontend)

1. Create an account at [netlify.com](https://netlify.com) if needed.
2. **Add new site** → **Import an existing project** → connect the same
   GitHub repo. Netlify reads `netlify.toml` at the repo root automatically
   (base directory `frontend/`, build command `npm run build`, publish
   directory `dist`) — you shouldn't need to touch the build settings.
3. Before the first deploy (or after, then redeploy), go to **Site
   configuration** → **Environment variables** and add:
   - `VITE_API_URL` = `https://football-quiz-backend-d2f5.onrender.com/api`
     (your actual Render URL from step 2.5 — copy it from the dashboard,
     don't assume the un-suffixed name — with `/api` on the end, matching
     the local `.env.example` convention).
4. Deploy. Note the resulting site URL, e.g.
   `https://your-site-name.netlify.app`.

Client-side routing (e.g. a coach refreshing on `/quizzes/5`) is handled by
`frontend/public/_redirects`, which Vite copies into the build output —
nothing to configure for that.

## 4. Close the loop: update CORS_ORIGINS

Back in Render → the web service → **Environment**, update `CORS_ORIGINS`
to your real Netlify URL from step 3.4 (e.g.
`https://your-site-name.netlify.app`). Save — Render restarts the service
automatically. Without this step, the deployed frontend's API requests will
fail CORS and every request will error out in the browser console.

## 5. Verify the full flow, on the deployed URLs

Do this on the live Netlify/Render URLs, not localhost — that's the whole
point. Matches the flow the platform is built around end to end:

1. **Register/log in** as a coach on the Netlify URL.
2. **Create a quiz**, add a true/false or multiple-choice question.
3. **Upload an image** to a question and **annotate** it (draw a route,
   circle a player) — this is the step that proves R2 is wired correctly;
   if it fails or the image doesn't reload after a page refresh, re-check
   the `R2_*` env vars on Render.
4. **Add a roster** and **activate** the quiz to generate an access code.
5. Open an incognito/private window (simulating a player, no login) and
   **play the quiz** using the access code.
6. Back as the coach, **grade** the written answer (if any) and check the
   **Results** tab shows the response.
7. **Export CSV and PDF** from the Results tab and confirm both download
   and open correctly.

If all seven steps work on the deployed URLs, you're clear for real players.

## Updating a deployment later

Both Render and Netlify auto-deploy on push to the branch they're
connected to (default `main`/`master`) — no extra steps needed for routine
changes. A schema migration runs automatically on every backend deploy via
`preDeployCommand`.
