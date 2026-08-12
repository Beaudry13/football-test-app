# Competition Mode — M1 API contract

Frozen for the Milestone 1 frontend. Two additions were required while
building it, both recorded below: the coach-reconnect lookup
(`/sessions/by-code/<code>`), which the frozen contract had no way to express,
and a rate-limit correction the load harness forced. No frozen payload shape,
credential rule, or error code changed. M2 adds rounds and scoring on top of this
without changing anything below.

Base path: `/api/competition`

---

## 1. The two identities

| | Coach (host) | Player |
|---|---|---|
| Credential | JWT `Authorization: Bearer …` | join code + `X-Competition-Token` |
| Scope | own organization, own or admin-visible quiz | one seat in one session |
| Failure mode | `404` (never `403` — a `403` confirms the session exists) | `401` |

### Player reconnect security

**A `player_id` is not a credential, and neither is a `participant_id`.** Both
are sequential, and both are *published*: `GET /<code>` returns every eligible
`player_id` so the identity picker can render, and the host view lists
participant ids. Pairing either with the public join code must prove nothing.

So each seat carries an opaque secret:

- `secrets.token_urlsafe(32)` — 256 bits from the OS CSPRNG
- minted **once**, when the seat is first taken
- **not** derived from `player_id`, `participant_id`, or the join code
- returned in **exactly one response**: the successful first `POST /join`
- absent from every other payload — lobby, poll, host view, `to_dict()`
- sent back as the `X-Competition-Token` **header** (not a path or query
  parameter, which would land in access logs, history and `Referer`)
- validated by looking the participant up **by token, scoped to the session**
- revoked when the coach removes the participant, and dead once the session is
  terminal

**Picking your name stays open** — that is the product. Proving you *are* that
player afterwards is what takes the secret.

**Lost token?** The identity is *not* silently reissued. `POST /join` for a
taken seat returns `409 identity_taken` and no token. Recovery is the coach
removing that participant, which frees the identity for a fresh join with a
**new** token. The coach can see who is actually standing in the room; the
server cannot.

---

## 2. Host endpoints — JWT required

| Method | Path | Notes |
|---|---|---|
| `GET` | `/quizzes/<quiz_id>/readiness` | can this quiz run, and if not, which questions block it |
| `POST` | `/quizzes/<quiz_id>` | create session → `201` |
| `GET` | `/sessions/<id>` | full host view (fetch on version change) |
| `GET` | `/sessions/by-code/<code>` | **coach reconnect** — resolve a code to the host view |
| `GET` | `/active` | **coach recovery** — live sessions this coach may control |
| `GET` | `/sessions/<id>/state` | host heartbeat — same tiny payload as players |
| `DELETE` | `/sessions/<id>/participants/<pid>` | lobby only |
| `POST` | `/sessions/<id>/transition` | **M2** move the room forward |
| `POST` | `/sessions/<id>/end` | idempotent |

Ownership: `get_visible_quiz()` for creation (organization + quiz visibility),
then `coach_session()` — organization match **and** (`coach_id == me` or
`coach.is_admin()`). **Platform-owner status grants nothing here.** `owner.py`
is a separate blueprint and `require_platform_owner()` is never consulted by
Competition; an owner who is not the host and not an org admin gets the same
`404` as anyone else.

## 3. Player endpoints — public

| Method | Path | Token | Notes |
|---|---|---|---|
| `GET` | `/<code>/state` | no | **the 1 Hz poll** |
| `GET` | `/<code>` | no | lobby + eligible roster |
| `POST` | `/<code>/join` | on retry only | issues the token |
| `GET` | `/<code>/me` | **yes** | reconnect |

Join codes are 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no `O/0/I/1`),
matched case-insensitively.

---

## 4. Payloads

**A. Create** `POST /quizzes/<id>` `{group_ids?: number[], question_time_seconds?: 10|20|30|45|60}` → `201`, same shape as F.

**B. Lobby** `GET /<code>`
```json
{ "join_code": "9K6JTM", "status": "LOBBY", "version": 4,
  "quiz_title": "Coverages", "question_time_seconds": 20,
  "server_now": "2026-08-12T13:20:08.055732+00:00",
  "roster": [{"player_id": 12, "display_name": "Ada Lovelace", "taken": true}],
  "participants": [{"id": 3, "display_name": "Ada Lovelace"}] }
```

**C. Join** `POST /<code>/join` `{player_id}` → `200`
```json
{ "participant": {"id": 3, "player_id": 12, "display_name": "Ada Lovelace",
                  "joined_at": "…", "total_points": 0,
                  "current_streak": 0, "best_streak": 0},
  "reconnect_token": "xK3…",            // ONLY here, ever
  "join_code": "9K6JTM", "status": "LOBBY", "version": 4 }
```

**D. Poll** `GET /<code>/state` — **exactly these twelve keys** *(M2.1)*
```json
{ "version": 9, "status": "QUESTION_OPEN",
  "server_now": "2026-08-12T13:20:08.055732+00:00",
  "current_round": 2, "total_rounds": 10,
  "question_opened_at": "…", "question_closes_at": "…",
  "participant_count": 22, "answered_count": 18,
  "all_in": false, "answering_open": true, "podium_step": 0 }
```

Every field is a scalar, timestamp or boolean. **No names, no ids, no question
content, no options, no tokens** — the 1 Hz path stays free of anything
identifying and anything expensive.

`answered_count` and `all_in` **do not bump `version`.** Counters ride the
poll; `version` marks structural change only. Bumping per submission would
make 30 phones refetch heavy state 30 times a round — the stampede the M1
harness caught.

`answering_open` is **derived, not a state**: it requires
`question_opened_at ≤ now < question_closes_at` **and** status
`QUESTION_OPEN`. Checking only the close time would have left the window open
during the 3‑2‑1 lead-in — a player could answer a question not yet on screen.
A test caught exactly that.
No roster, no participants, no leaderboard, no question, no player-private
state. A test asserts the key set exactly, and asserts one `SELECT` and zero
writes. `server_now` exists so a client renders a countdown from the server's
deadline instead of its own clock.

**`participant_count` is a scalar and nothing more** — no names, ids, or
tokens. It exists so the player waiting room shows "12 in the room" without
fetching the lobby; that screen now makes **zero** heavy fetches.

It is a SQLAlchemy `column_property`, so the count is a correlated subquery
**inside the poll's single SELECT** — not a second round trip, and not a lazy
load of the participant collection. Measured plan:

```
Aggregate  (actual time=0.043..0.044 rows=1)
  -> Index Only Scan using ix_competition_participants_session_id
Execution Time: 0.069 ms
```

Derived, not stored: a denormalised counter would need incrementing on join
and decrementing on removal, and a drifted count never announces itself.

**I. Active** `GET /active` → `[]` or
```json
[{ "id": 7, "join_code": "9K6JTM", "quiz_id": 3, "quiz_title": "Coverages",
   "status": "LOBBY", "participant_count": 18,
   "created_at": "…", "expires_at": "…" }]
```
Non-terminal **and** unexpired only, scoped to the coach (or the organization
for an admin). Not a history list. No participant identities.

**E. Reconnect** `GET /<code>/me` + `X-Competition-Token` →
`{participant, status, version, server_now}` — the only player-private
endpoint in M1.

**F. Host view** `GET /sessions/<id>`
```json
{ "id": 7, "quiz_id": 3, "quiz_title": "Coverages", "join_code": "9K6JTM",
  "status": "LOBBY", "version": 4, "current_round": 0,
  "question_time_seconds": 20, "participant_count": 1,
  "created_at": "…", "started_at": null, "ended_at": null, "expires_at": "…",
  "participants": [ /* to_dict(), never a token */ ],
  "eligible_count": 3,
  "not_joined": [{"player_id": 14, "display_name": "Alan Turing"}] }
```

**G. Remove** `DELETE /sessions/<id>/participants/<pid>` → host view (F).
**H. End** `POST /sessions/<id>/end` → host view (F), `status` `COMPLETE`
or `ABANDONED`.

---

## 4a. The M2 state machine

`LOBBY → QUESTION_OPEN ⇄ QUESTION_REVEAL → [LEADERBOARD] → … → PODIUM → COMPLETE`

| From | Action | To |
|---|---|---|
| `LOBBY` | `START_QUESTION` | `QUESTION_OPEN` |
| `QUESTION_OPEN` | `SHOW_ANSWER` | `QUESTION_REVEAL` |
| `QUESTION_REVEAL` | `SHOW_LEADERBOARD` / `NEXT_QUESTION` / `FINISH` | `LEADERBOARD` / `QUESTION_OPEN` / `PODIUM` |
| `LEADERBOARD` | `NEXT_QUESTION` / `FINISH` | `QUESTION_OPEN` / `PODIUM` |
| `PODIUM` | `ADVANCE_PODIUM` / `COMPLETE` | `PODIUM` / `COMPLETE` |

Anything absent from that table is impossible by construction, not by a check.
A test walks the **entire** product of states × actions.

`POST /sessions/<id>/transition` takes `{action, expected_version}`.
**`expected_version` is required**: it is what makes two host tabs, and one
double-clicked button, safe — the loser gets `409 stale_transition` carrying
the current version so it can resync. Version rather than status, because two
clicks of NEXT QUESTION arrive in the same status and must still not both
apply.

**No transition is automatic.** The only time-driven behaviour in Competition
is `answering_open` flipping to false, which changes no state and bumps no
version — that is precisely what lets the clock close answering while the
coach still controls when the room sees the answer.

**`all_in`** (every seat answered) is informational. It does not close the
window and does not reveal anything; it exists so the host can stop watching a
clock with nobody left to wait for.

**`question_order`** is frozen at the first `START_QUESTION`. Rounds index into
it, never into `quiz.questions`, so a coach editing the quiz mid-competition
cannot shift which question a round plays.

## 5. Version — what bumps it

The frontend refetches heavy state **only** when `version` changes.

**Bumps:** participant joins (new seat only) · participant removed · session
ends/abandons · expiry sweep · **every M2 round transition**.

**Does not bump:** any `GET`, the 1 Hz poll, a token-verified rejoin, a
reconnect, `last_seen_at`, **an answer being submitted**, **the clock
expiring**. A rejoin loop that bumped the version would make
every phone in the room refetch continuously — there is a test for it.

## 6. Expiry — no background worker

- Lobbies expire **6 hours** after creation (`LOBBY_LIFETIME`).
- Enforcement is **lazy and on-request**: `join()` checks `is_expired` itself,
  so an expired code stops working the moment someone uses it, with or without
  any sweep.
- `expire_stale_sessions()` is opportunistic tidying that flips stale sessions
  to `ABANDONED`. **Nothing depends on it running.** There is no worker in this
  deployment and this contract does not assume one.
- Unstarted lobby ended by the coach → `ABANDONED`, never `COMPLETE`: calling
  an event that never happened "complete" would misreport it forever.
- Terminal sessions reject joins (`409`), reject the lobby view (`410`), and
  their tokens stop working.

## 7. Error codes — never parse English

| HTTP | `reason` | Meaning |
|---|---|---|
| `404` | `invalid_code` | unknown join code |
| `410` | `session_expired` | lobby past `expires_at` |
| `409` | `session_ended` | joining a terminal session |
| `410` | *(none)* | lobby view of a terminal session |
| `404` | `not_eligible` | player not on the roster / another organization |
| `409` | `identity_taken` | seat held by someone else — coach must remove |
| `409` | `already_started` | past `LOBBY` |
| `401` | `missing_token` | player-private request with no token |
| `401` | `invalid_token` | wrong, foreign, or revoked token |
| `422` | `unsupported_questions` | `details.unsupported_questions[]` lists them |
| `422` | *(none)* | empty quiz, bad `question_time_seconds` |
| `404` | *(none)* | host route, wrong organization or not the host |
| `401` | *(none)* | host route, no JWT |

`invalid_token` is returned identically for a wrong token and a removed seat —
distinguishing them would confirm which tokens exist.

## 8. Rate limiting

| Endpoint | Limit | Key |
|---|---|---|
| `/<code>/state` | **none** | — |
| `/<code>` | 1800/min | **join code** |
| `/<code>/join` | 30/min | **(join code, player_id)** |

Nothing is IP-keyed, so a team behind one Wi-Fi NAT cannot rate-limit itself
out of its own competition. `default_limits` remains empty; nothing global was
loosened.

**Why 1800 and not 240.** The lobby endpoint is fetched on version change, and
every arrival bumps the version, so an N-player room filling up costs roughly
N x N fetches in the join window. At 240/min the load harness produced **150
rate-limited players in a 30-player room** — the feature limiting itself out of
its own lobby. 1800/min covers a room twice the expected size.

The client also **coalesces** heavy fetches to at most one per 2s
(`HEAVY_FETCH_MIN_INTERVAL_MS`), so a burst of ten joins in one second causes
one fetch, not ten. The limit's headroom is for the burst, not the steady
state. The pending state is never dropped — a change inside the window is
fetched when the window closes, so the roster always converges.

## 9. Indexing — measured, not assumed

The heavy lobby fetch issues **4 statements**, total execution **~0.35ms**:

| # | Query | Plan | Time |
|---|---|---|---|
| 1 | `competition_sessions` by `join_code` | Index Scan `ix_..._join_code` | 0.10ms |
| 2 | `competition_participants` by `session_id` | Index Scan `ix_..._session_id` | 0.14ms |
| 3 | `quizzes` by pk | Seq Scan (27 rows) | 0.03ms |
| 4 | `players` by `organization_id` + `is_active` | Seq Scan (189 rows) | 0.05ms |

The two seq scans are the planner's choice on tiny tables, not missing
indexes — `quizzes_pkey` and `ix_players_organization_id` both exist and win
once the tables are large enough to matter.

**No index was added, and no migration was written for this.** The 255ms p95
in the load harness is concurrency on a single-process dev server under 30
simultaneous clients, not database time — the SQL accounts for ~0.1% of it.

## 10. Analytics isolation

Competition writes only to `competition_sessions`, `competition_participants`,
`competition_answers`. Zero `player_attempts`, zero `answers`. Verified against
the real surfaces — `/quizzes/<id>/responses`, `/dashboard`, `export.csv`,
`/players/<id>/history` — not by asserting a table is empty.

`competition_sessions` is covered by Organization Merge (`ORG_OWNED_TABLES`);
participants and answers reference the *session*, so they follow. The
merge-coverage test is keyed on `organization_id` and fails if a future table
adds one without being handled.
