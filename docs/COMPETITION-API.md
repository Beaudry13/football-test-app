# Competition Mode — API contract

**Current through M2.5, plus the M2.6 lifecycle corrections.**

This document describes what the code does *today*. It was rewritten from the
implementation at M2.6 rather than extended from the M1 draft, because a
contract assembled out of per-milestone appendices stops being readable exactly
when it matters — during a live event, with a room waiting.

Base path: **`/api/competition`** (registered in `routes/__init__.py`).

Source of truth for everything below:

| Concern | File |
|---|---|
| HTTP surface | `backend/app/routes/competition.py` |
| Request validation | `backend/app/schemas/competition.py` |
| Statuses, payload shapes, derived properties | `backend/app/models/competition.py` |
| Eligibility, join, identity, lifecycle | `backend/app/services/competition.py` |
| Transition table | `backend/app/services/competition_rounds.py` |
| Submission and round scoring | `backend/app/services/competition_answers.py` |
| Model D | `backend/app/services/competition_scoring.py` |
| The reveal gate | `backend/app/services/competition_round_view.py` |
| Ranking and movement | `backend/app/services/competition_standings.py` |
| The ending | `backend/app/services/competition_podium.py` |

---

## 1. The two identities

| | Coach (host) | Player |
|---|---|---|
| Credential | JWT `Authorization: Bearer …` | join code (public) + `X-Competition-Token` (private) |
| Scope | own organization; own sessions, or the organization's if `is_admin()` | one seat in one session |
| Failure mode | `404`, never `403` — a `403` would confirm the session exists | `401` |

`coach_session()` checks tenancy first, then ownership, and raises `404` for
both. A coach from another organization cannot learn that a session exists,
whether they address it by id or by join code.

### 1.1 Player identity is an opaque seat token, and nothing else

**A `player_id` is not a credential, and neither is a `participant_id`.** Both
are sequential, and both are *published*: `GET /<code>` returns every eligible
`player_id` so the identity picker can render, and the host view lists
participant ids. Pairing either with a join code read off a projector must
prove nothing.

So each seat carries a secret:

- `secrets.token_urlsafe(32)` — 256 bits from the OS CSPRNG
- minted **once**, when the seat is first taken
- **not** derived from `player_id`, `participant_id`, or the join code
- returned in **exactly one response**: a successful `POST /<code>/join`
- absent from every other payload — `poll_state()`, the lobby, the host view,
  `CompetitionParticipant.to_dict()`. That omission is a security boundary and
  there is a test asserting it
- sent back as the **`X-Competition-Token` header** — never a path or query
  parameter, which would land in access logs, browser history and `Referer`
- validated by `participant_by_token()`: looked up **by token, scoped to the
  session**, so a token from one competition cannot address a seat in another
- compared with `secrets.compare_digest` on the join path, not `==`

**Deliberately never exposed, anywhere:**

- the token in any list, roster, poll, host view, or another player's payload
- another player's answer, selection, verdict, points, or streak
- who has *not* answered — the host gets `answered_count`, a scalar, never names
- the correct option, `answer_explanation`, or the distribution before the
  coach reveals (see §7)
- the standings before the room is being shown them (see §10)

**Picking your name stays open** — that is the product. Proving you *are* that
player afterwards is what takes the secret.

**Lost token?** The identity is *not* silently reissued. `POST /join` on a
taken seat returns `409 identity_taken` and **no token**. Recovery is the coach
removing that participant, which frees the identity for a fresh join with a
**new** token. The coach can see who is actually standing in the room; the
server cannot.

**Token lifetime — corrected at M2.6.** The token is **not** invalidated when
the session becomes terminal. `session_by_code()` and `participant_by_token()`
both continue to resolve at `COMPLETE` and at `ABANDONED`. That is deliberate
and load-bearing: at `COMPLETE` the player's final result must survive a
refresh (§12). The M1 draft of this document claimed the token was "dead once
the session is terminal"; it never was, and it must not become so. What *does*
refuse on a terminal session is `GET /<code>` (`410 session_ended`),
`POST /join` (`409 session_ended`), `POST /answer` (`409 session_ended`) and
every host transition.

---

## 2. Coach endpoints — JWT required

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/quizzes/<quiz_id>/readiness` | can this quiz run, and if not, exactly which questions block it |
| `POST` | `/quizzes/<quiz_id>` | create the session → `201` |
| `GET` | `/active` | **recovery** — live competitions this coach can walk back into (§13) |
| `GET` | `/sessions/by-code/<code>` | **coach reconnect** — resolve a code to the host view |
| `GET` | `/sessions/<id>` | the full host view; fetch on version change, never on a timer |
| `GET` | `/sessions/<id>/state` | the host's heartbeat — the same payload players poll |
| `POST` | `/sessions/<id>/transition` | **the only way the room moves forward** (§5) |
| `DELETE` | `/sessions/<id>/participants/<pid>` | remove a participant — **LOBBY only** |
| `POST` | `/sessions/<id>/end` | **always ABANDONS** (§12) |

### `GET /quizzes/<quiz_id>/readiness`

```json
{
  "quiz_id": 12,
  "question_count": 10,
  "supported_question_count": 8,
  "unsupported_questions": [
    { "question_id": 44, "position": 3, "question_type": "written",
      "reason": "Draw Response and Short Answer need a coach to grade them, so they cannot be scored live." }
  ],
  "can_launch": false
}
```

`can_launch` requires at least one question and **zero** blocking questions.
Competition V1 supports `MULTIPLE_CHOICE` and `TRUE_FALSE` only
(`COMPETITION_QUESTION_TYPES`), asserted at import time to be a subset of
`AUTO_GRADABLE_TYPES`. `FILL_BLANK` is auto-gradable but exists only as a
masked region on a playbook page, which does not fit a twenty-second round;
`WRITTEN` and `DRAW_RESPONSE` need a human grader and so cannot produce an
honest live leaderboard.

### `POST /quizzes/<quiz_id>` → `201`

Request (all optional — the body itself may be absent):

```json
{ "group_ids": [3, 7], "question_time_seconds": 20 }
```

- `group_ids` empty/absent → the whole active master roster.
- Group ids are re-checked against the caller's organization **before being
  stored**; an unknown or foreign id → `404`. Validating once at creation is
  what keeps `eligible_players()` from having to defend against a stored
  cross-tenant id on every read.
- `question_time_seconds` ∈ `{10, 20, 30, 45, 60}` (`QUESTION_TIME_CHOICES`),
  default `20`. Anything else → `422` (from the marshmallow validator; the
  route uses `load_optional_json_body`, so a bad value is a `422` and not a
  `500`).
- One session-level setting. Per-question timing is deliberately not built.

Returns the **host view** (§3).

### `DELETE /sessions/<id>/participants/<pid>`

`409` unless `status == LOBBY`. Removing someone mid-competition would delete
answers they had already given and silently change everyone else's rank. Bumps
the version (which is how the removed player's phone finds out). Returns the
host view.

### `POST /sessions/<id>/end`

See §12. **This always produces `ABANDONED`.** Idempotent on an
already-terminal session (`end_session` returns early). Returns the host view.

---

## 3. The host view

Returned by `POST /quizzes/<id>`, `GET /sessions/<id>`,
`GET /sessions/by-code/<code>`, `POST .../transition`, `POST .../end`, and
`DELETE .../participants/<pid>`. Built by `_host_view()` on top of
`CompetitionSession.to_dict(include_participants=True)`.

```jsonc
{
  // to_dict()
  "id": 8, "quiz_id": 12, "quiz_title": "Coverages", "join_code": "5Q6CHN",
  "status": "QUESTION_OPEN", "version": 14,
  "current_round": 2, "total_rounds": 10, "podium_step": 0,
  "scoring_version": 1, "question_time_seconds": 20,
  "participant_count": 12,
  "created_at": "…", "started_at": "…", "ended_at": null, "expires_at": "…",
  "participants": [ /* CompetitionParticipant.to_dict() — NEVER a token */ ],

  // _host_view() additions
  "eligible_count": 18,
  "not_joined": [ { "player_id": 41, "display_name": "Ada Lovelace" } ],
  "available_actions": ["SHOW_ANSWER"],
  "leaderboard_hint": "first_standings",
  "answered_count": 9,
  "all_in": false,
  "answering_open": true,
  "round": { /* §7 host round, or null */ },
  "standings": [ /* §9 top 5 — ONLY while status == LEADERBOARD, else null */ ],
  "scored_rounds": 2,
  "last_leaderboard_round": 0,
  "podium": { /* §11 — only at PODIUM and COMPLETE, else null */ }
}
```

`participants[]` is `CompetitionParticipant.to_dict()`:
`id, player_id, display_name, joined_at, total_points, current_streak,
best_streak`. **No `reconnect_token`, no `last_seen_at`.**

`not_joined` is the **lobby** roster — who has not *arrived*. It is never "who
has not answered": names of players still answering are not published on the
projector or anywhere else.

`available_actions` is derived from the same `TRANSITIONS` table the server
enforces, so a button cannot exist for a move that would be refused. Two
refinements on top of the raw table: `ADVANCE_PODIUM` disappears once
`podium_step >= PODIUM_LAST_STEP`, and `NEXT_QUESTION` disappears when no
playable round remains. Terminal sessions return `[]`.

`leaderboard_hint` is a **suggestion, never a rule** — it never transitions,
hides, or disables anything. First match wins:

| Value | When |
|---|---|
| `first_standings` | after round 0, and more rounds remain |
| `keep_the_finish_a_surprise` | 1 or 2 playable rounds left |
| `midpoint_standings` | ≥8 rounds, every 4th round, while >2 remain |
| `null` | otherwise, and always outside `QUESTION_REVEAL`/`LEADERBOARD` |

> **Note on frontend types.** `CompetitionHostView` in
> `frontend/src/api/competition.ts` does not declare `total_rounds`,
> `podium_step`, or `scoring_version`. The server sends them; the client simply
> has no use for them yet. The backend payload above is authoritative.

---

## 4. The seven statuses

| Status | Meaning | Terminal | Joinable |
|---|---|---|---|
| `LOBBY` | open, filling up, nothing started | no | **yes** |
| `QUESTION_OPEN` | a round is live; answering may or may not still be open (§6) | no | no |
| `QUESTION_REVEAL` | the answer is out; this round has been scored | no | no |
| `LEADERBOARD` | the room is being shown standings | no | no |
| `PODIUM` | the coach-paced ending, one place at a time | no | no |
| `COMPLETE` | the competition **finished** — the podium was walked to its end | **yes** | no |
| `ABANDONED` | the competition was **stopped**, or the lobby expired | **yes** | no |

`COMPETITION_STATUSES` is a VARCHAR plus a `CHECK` constraint, **not** a native
Postgres enum — a live state machine is exactly the kind of thing that gains a
state later, and a native enum makes that a one-way door (see `CLAUDE.md`).

`TERMINAL_STATUSES = (COMPLETE, ABANDONED)`. `JOINABLE_STATUSES = (LOBBY,)` —
late joiners are blocked, because a participant with no score for rounds
already played, ranked against people who played them, is worse than being told
to wait.

Both sides agree: `frontend/src/api/competition.ts` declares the same seven and
the same `TERMINAL_STATUSES`.

---

## 5. Transitions

**One endpoint, one table.** `POST /sessions/<id>/transition`:

```json
{ "action": "SHOW_ANSWER", "expected_version": 14 }
```

Both fields are **required**; `expected_version` has no default on purpose.

`TRANSITIONS` — the entire legal surface:

| From | Action | To |
|---|---|---|
| `LOBBY` | `START_QUESTION` | `QUESTION_OPEN` |
| `QUESTION_OPEN` | `SHOW_ANSWER` | `QUESTION_REVEAL` |
| `QUESTION_REVEAL` | `SHOW_LEADERBOARD` | `LEADERBOARD` |
| `QUESTION_REVEAL` | `NEXT_QUESTION` | `QUESTION_OPEN` |
| `QUESTION_REVEAL` | `FINISH` | `PODIUM` |
| `LEADERBOARD` | `NEXT_QUESTION` | `QUESTION_OPEN` |
| `LEADERBOARD` | `FINISH` | `PODIUM` |
| `PODIUM` | `ADVANCE_PODIUM` | `PODIUM` |
| `PODIUM` | `COMPLETE` | `COMPLETE` |

Note what is **absent**: no way back into `QUESTION_OPEN` from `PODIUM`, no
reveal before starting, and **no way to reach `COMPLETE` without passing
through the podium**. Those are not checks — there is simply no row.

> The action constant is `COMPLETE_COMPETITION` in Python; its **wire value is
> `"COMPLETE"`**. `ACTIONS` is what the marshmallow validator accepts.

### Side effects (`_apply`)

| Action | Effect |
|---|---|
| `START_QUESTION` | freeze `question_order`; set `started_at`; **renew `expires_at` to `started_at + LIVE_LIFETIME`** (§13); open round 0 |
| `NEXT_QUESTION` | retire the leaderboard baseline (§9); open `current_round + 1` |
| `SHOW_ANSWER` | stamp `scoring_version`; **score the round** (§8), once, idempotently |
| `FINISH` | retire the leaderboard baseline; `podium_step = 0` |
| `ADVANCE_PODIUM` | `podium_step += 1`; `409 podium_finished` past the last step |
| `COMPLETE` | set `ended_at` |

Every applied transition calls `session.bump()` and commits.

### Refusals, in the order they are checked

| Condition | Status | `reason` |
|---|---|---|
| action not in `ACTIONS` | `422` | `unknown_action` |
| session already terminal | `409` | `session_ended` |
| `expected_version != session.version` | `409` | `stale_transition` |
| no `(status, action)` row | `409` | `illegal_transition` |
| `ADVANCE_PODIUM` past the last step | `409` | `podium_finished` |
| `START_QUESTION` with no playable question | `422` | `no_playable_questions` |
| `NEXT_QUESTION`/`START_QUESTION` onto a missing round | `409` | `no_such_round` |

**`stale_transition` is the two-tab and double-click guard.** It carries
`details: { current_version, status }` so the client can resync rather than
argue. Version is used rather than status because two clicks of `NEXT_QUESTION`
arrive in the *same* status and must still not both take effect. The host UI
resyncs by refetching the view and does not surface an error for this case.

---

## 6. `QUESTION_OPEN` — the clock

Both ends of the window are server timestamps, stored on the session and
published in every relevant payload. Clients render from
`(question_opened_at, question_closes_at, server_now)` — **never** from a local
timer started on arrival, which is what makes a refresh, a sleeping phone and a
reconnect all land on the correct remaining time and makes it impossible to
gain a second by reloading.

```
START_QUESTION at T
  question_opened_at = T + LEAD_IN            (LEAD_IN = 3s)
  question_closes_at = question_opened_at + question_time_seconds
```

**The 3-2-1 lead-in needs no state.** It is simply `question_opened_at` being
in the future. A reconnect during the lead-in is therefore automatically
correct.

### `answering_open` — derived, never a status

```python
status == QUESTION_OPEN
  and question_opened_at <= now < question_closes_at
```

**Both ends matter.** Checking only the close time left the window open during
the lead-in, when the question is not yet on anyone's screen — a player could
answer a question they had not been shown. That was a real defect, fixed and
regression-tested.

Answering closes because the clock ran out, **not because anything
transitioned**. The session sits in `QUESTION_OPEN` with the window shut, and
the coach reveals when the teaching moment is right. Nothing fires on a timer;
there is no background worker.

### The 750ms network grace

`NETWORK_GRACE = 750ms` (`competition_answers.py`). An answer is accepted while
`now <= question_closes_at + NETWORK_GRACE`.

- It is for the **network**, not the player. A tap at 19.9s on a slow
  connection arrives late through no fault of the person who made it.
- **It is never disclosed.** It appears in no payload, and the visible
  countdown ends at the real deadline.
- **It never scores.** `clamp_response_ms` pins a grace-window answer to the
  full question duration, so it lands in the last quartile. The grace buys
  inclusion, never points.

### Server-authoritative response timing

`response_ms = clamp(int((received - question_opened_at) * 1000), 0, window_ms)`
where `received` is the server's own clock at the moment the request is
handled. The request has **no** timing field — there is nothing to tamper with.

### `all_in`

```python
status == QUESTION_OPEN and participant_count > 0 and answered_count >= participant_count
```

**Informational only.** It does not close the window, does not reveal anything,
and changes no state. It exists so the host can stop watching a clock with
nobody left to wait for and move into the reveal when they choose. Server
authority and coach control both survive precisely because it is inert.

---

## 7. The reveal gate

One module decides whether the answer is public:
`REVEALED_STATUSES = (QUESTION_REVEAL, LEADERBOARD, PODIUM, COMPLETE)`.
`QUESTION_OPEN` is deliberately absent — that is the whole point.

Gated behind `is_revealed()`, in both the host and player payloads:

- `options[].is_correct_answer` (via `Question.to_dict(include_correct_answers=)`,
  reusing Peira's existing rule rather than inventing a second one)
- `correct_option_id`
- `answer_explanation` — **the teaching moment**
- `distribution` — counts per option, **never who chose what**. Publishing
  individual answers on a wall would make a wrong answer a public event with a
  name attached.
- the player's own `result` (§8)

### Host round (`host_round`) — `null` if the current question no longer exists

```jsonc
{
  "round_index": 2, "round_number": 3, "total_rounds": 10,
  "question": { "id": 44, "question_text": "…", "question_type": "multiple_choice",
                "image": "…", "options": [ { "id": 91, "option_text": "Cover 2", "position": 0 } ],
                // revealed only:
                "answer_explanation": "…", "correct_option_id": 91 },
  "answered_count": 9, "participant_count": 12,
  "all_in": false, "answering_open": true,
  "question_opened_at": "…", "question_closes_at": "…",
  "distribution": null   // [{option_id, option_text, count, is_correct_answer}] once revealed
}
```

### Player round — `GET /<code>/round`, token required

```jsonc
{
  "round_index": 2, "round_number": 3, "total_rounds": 10,
  "status": "QUESTION_REVEAL", "server_now": "…",
  "question": { /* same gating */ },
  "question_opened_at": "…", "question_closes_at": "…",
  "answering_open": false,
  "answered": true, "selected_option_id": 91,
  "result": {                       // null until revealed
    "answered": true,
    "is_correct": true,             // null — NOT false — when they never answered
    "points_earned": 118,
    "total_points": 336, "current_streak": 3, "best_streak": 3
  },
  "standing": { /* §10 — only while status == LEADERBOARD, else null */ },
  "podium":   { /* §11 — only at PODIUM and COMPLETE, else null */ },
  "final_result": { /* §11 — only at PODIUM and COMPLETE, else null */ }
}
```

`result.is_correct` is `null` rather than `false` for a player who never
answered: "no answer" and "wrong" deserve different words, and conflating them
tells a player they got something wrong they were never given the chance to get
right. `result` **is** populated for a non-answerer once revealed, so a player
who missed a question still receives the explanation.

This route also stamps `participant.last_seen_at`.

---

## 8. Scoring — Model D

`competition_scoring.py`. Pure, deterministic, no I/O.
**`SCORING_VERSION = 1`**, stamped onto `session.scoring_version` at every
`SHOW_ANSWER`, so an old competition's standings stay explainable rather than
being silently reinterpreted when the formula changes.

### The guarantee

> **More correct answers ALWAYS outrank fewer correct answers.**

Not "usually", not "in realistic rooms". At every competition length, against
any combination of speeds.

| Constant | Value |
|---|---|
| `BASE_POINTS` | `100` — what a correct answer is worth |
| `SPEED_BUDGET` | `90` — speed's total worth across the **entire** competition |
| `QUARTILE_SHARES` | `(1.0, 0.7, 0.4, 0.1)` |

Because `SPEED_BUDGET < BASE_POINTS`:

```
best  possible with X   correct = 100X + 90
worst possible with X+1 correct = 100X + 100
```

The second always exceeds the first, by at least 10, for every X and every
length. That is arithmetic, not statistics. A per-question bonus cannot promise
this — it accumulates on the same axis as correctness and always catches up
given enough questions (simulated: `100 + 20/15/10/5` inverted accuracy in
1.13% of pairs at 20 questions, with 9/10 beating 10/10 in the extreme case).
Model B was withdrawn for exactly this reason.

### Per-round cap — a difference of floors, not a division

```python
cap(i) = (90 * (i+1)) // N  -  (90 * i) // N
```

These sum to **exactly** 90 for any N, using only integers, with no rounding
drift. The obvious `round(90/N)` is wrong and breaks the guarantee: at N=100 it
gives 1 per round, so maximum total speed is 100 — exactly one correct answer.

### One answer

```python
if not is_correct: return 0            # no consolation, and NO speed points
cap    = speed_cap(round_index, total_rounds)
share  = QUARTILE_SHARES[quartile_for(clamp_response_ms(response_ms, window_ms), window_ms)]
return BASE_POINTS + round(cap * share)
```

Answering instantly and wrongly is worth exactly as much as not answering.

### When scoring happens

At **`SHOW_ANSWER`**, once, for the whole round, in one transaction —
`score_round()`. Not at submission: per-submission scoring would race the
leaderboard against stragglers, and a double-clicked reveal would double-award.

`points_awarded` is `0` at submission. **Zero there is "not yet", not a score.**

**Idempotent.** The guard is the answer rows themselves — an answer already
carrying points is skipped — so a replay, a retry, or a re-applied transition
cannot award a single extra point. Nothing depends on remembering whether it
ran.

Missing a round breaks a streak exactly as a wrong answer does, guarded by
`scored` so a replay cannot reset a streak twice.

### Streaks

**Presentation only, worth zero points.** `next_streak` is `+1` on correct, `0`
otherwise. Nothing in `score_answer` reads a streak, and a test proves that
mutating streak values cannot change a single point.

---

## 9. Standings

`competition_standings.py`. **Everything is derived** — no rank is stored
anywhere, so standings cannot drift from the answers that produced them.

### Ranking is points-only, and ties are real

Standard competition ranking: equal points share a rank and the next distinct
score skips — **1, 2, 2, 4**; three tied for second gives 1, 2, 2, 2, 5.

There is deliberately **no fallback tiebreaker** — not participant id, not
name, not response time, not streak, and **not correct count**. Model D already
guarantees that more correct answers outrank fewer, so correct count does not
need to participate in the sort to protect knowledge; adding it would only
reorder players who genuinely scored the same, which is precisely where a tie
is the honest answer.

Every participant is seeded at zero before answers are summed, so someone who
never answered still appears and still ranks. Dropping them would quietly
shrink the room.

### What counts

`scored_through()` — the last round whose answers have been scored. Mid-question
(not revealed) that is `current_round - 1`, so **standings never move while
people are still answering**.

`scored_rounds` is the denominator: rounds actually **played and scored**, not
the frozen quiz length. A competition 9 rounds into 15 shows "8 / 9", not
"8 / 15". Rounds skipped because their question was deleted are never reached
and never counted.

### Movement, and `last_leaderboard_round`

`movement = previous_rank - rank` (positive = climbed), or `null` when the room
has never been shown standings — which the client renders as **NEW** rather
than pretending somebody moved from a rank nobody saw.

"Previous" means **the rank at the last leaderboard the room ACTUALLY SAW**,
recorded in `session.last_leaderboard_round`.

**The baseline advances when the room LEAVES the leaderboard, not when it is
shown** (`_retire_leaderboard`, called from `NEXT_QUESTION` and `FINISH` and
only when `status == LEADERBOARD`). Setting it at `SHOW_LEADERBOARD` meant the
board was compared against **itself**: the first leaderboard showed every row
unchanged instead of NEW, and every later one showed zero movement for
everybody. A unit test missed it by reading the table while still in
`QUESTION_REVEAL`; an eight-player walkthrough found it immediately — every
arrow was a dash. **A leaderboard the coach skipped never becomes a baseline**,
because the retire path is never traversed.

### Row shape

```json
{ "participant_id": 41, "display_name": "Ada Lovelace", "rank": 2,
  "total_points": 336, "correct_count": 3, "current_streak": 2,
  "scored_rounds": 4, "previous_rank": 4, "movement": 2 }
```

### The projector's table — `top(session, limit=5)`

Five, not thirty: a wall of names is unreadable from the back of a room and
makes placement meaningless. **Ties at the boundary are kept whole** — the
cutoff is `table[4]["rank"]` and *every* row at or above it is returned, so
three players tied for fifth all appear rather than two being shown and the
third arbitrarily cut. Present in the host view **only while
`status == LEADERBOARD`**; computing it during a question would be work nobody
can see, and exposing it would leak the suspense the reveal exists to build.

---

## 10. A player's own standing

`standing_for()` — on `GET /<code>/round`, resolved **from the token**, present
**only while `status == LEADERBOARD`** so a phone cannot read the ranking early.

The player's own row plus one field:

```json
{ "...": "the standings row above", "tied": 2 }
```

`tied` is how many share this rank, so a phone can honestly say **"T-2ND"**
rather than implying sole possession of the place. It is computed from the one
`standings()` call rather than a second one — the two-call version measured 4
SELECTs against 3 on a path thirty phones hit simultaneously the moment the
board goes up.

Never anybody else's row, and nothing about how anyone answered.

---

## 11. `PODIUM` — the ending

A **real server state**, not a client animation, because every phone must agree
on which place has been revealed; a client-side sequence would desync the room
mid-suspense.

### `podium_step` — a fixed sequence

| Step | Constant | Meaning |
|---|---|---|
| 0 | `PODIUM_COMPLETE_CARD` | "that's a wrap" card |
| 1 | `PODIUM_THIRD` | third place |
| 2 | `PODIUM_SECOND` | second place |
| 3 | `PODIUM_FIRST` | first place |
| 4 | `PODIUM_STANDINGS` = `PODIUM_LAST_STEP` | full final standings |

`FINISH` sets `podium_step = 0`. Each `ADVANCE_PODIUM` increments by one and
`409 podium_finished` past the last step. It rides the 1 Hz poll, so a refresh
or a second host tab lands on the same beat.

### The slot rule

A podium place is **"whoever holds rank N"**. Standard competition ranking
means ranks skip after a tie — two tied at the top produce 1, 1, 3 and **there
is no second place**. That is not a gap to paper over; it is what happened.
`place_holders()` therefore returns an empty list, and nobody is promoted into
a place they did not earn.

**Empty places are announced, not skipped.** The step sequence stays fixed even
when a place is empty, for two reasons: `podium_step` keeps a stable meaning
across a refresh, a second host tab and every phone (a sequence whose length
depended on the tie shape would have to be recomputed identically everywhere);
and *"there is no second place — two players tied for first"* is a better
moment than silently jumping from third to first, and it is true.

Nothing in `competition_podium.py` ranks anything — it reads the standings the
leaderboard already produced, so the podium and the final table can never
disagree about who won.

### Payload

```jsonc
{
  "step": 3, "last_step": 4,
  "places": {
    "1": [ { "participant_id": 41, "display_name": "Ada Lovelace", "rank": 1,
             "total_points": 436, "correct_count": 4, "scored_rounds": 4 } ],
    "2": [],
    "3": [ /* … */ ]
  },
  "empty_places": [2],
  "winners": ["Ada Lovelace"],
  "final_standings": [ /* EVERYONE, ranked, + best_streak */ ]
}
```

`final_standings` is **everyone**, not a top five: the competition is over,
there is no suspense left to protect, and a player who came 19th is still part
of the result. Each row adds `best_streak`.

`final_result_for()` gives one player their own ending — the same
`standing_for()` row plus `best_streak` and `is_winner` (`rank == 1`), so the
number on a phone and the number on the projector come from one calculation.

Both `podium` and `final_result` are present at **`PODIUM` and `COMPLETE`**.

---

## 12. `COMPLETE` vs `ABANDONED` — corrected at M2.6

These are **not** two ways of saying "over". They are a success and a
cancellation, and M2.6 made the difference visible to every player.

| | `COMPLETE` | `ABANDONED` |
|---|---|---|
| Meaning | the competition **finished** | the competition was **stopped**, or the lobby expired |
| Reachable by | **only** `PODIUM → COMPLETE`, i.e. walking the podium to its end | `POST /sessions/<id>/end`, from **any** non-terminal status |
| `podium` / `final_result` | **present** | `null` |
| Player's seat token | **preserved** — still resolves | still resolves, but the client clears the seat on seeing the status |
| Player sees | their final result, and the podium | "Competition ended — your coach has ended this competition" |
| In `GET /active` | no | no |

### `/end` ALWAYS means ABANDONED

`POST /sessions/<id>/end` calls `end_session(session, abandoned=True)`,
unconditionally. It is the *"stop, we are not doing this"* control, wherever
the room happens to be — it is not a way to finish.

It used to compute `abandoned = (status == LOBBY)`. That was correct in M1,
where `LOBBY` was the only non-terminal state and the `COMPLETE` branch was
unreachable. Once M2.1–M2.5 added rounds, standings and the podium, ending
mid-round started taking that branch and **recording a cancelled event as
COMPLETE** — which, once `COMPLETE` gained real player meaning, left every
phone showing "YOUR FINAL RESULT" and the projector showing a podium for a
competition nobody finished. Regression-covered by
`TestEndingSemantics` in `tests/test_competition_podium.py`.

### COMPLETE preserves the player's credential

At `COMPLETE` the player has just been shown their final result. The seat token
must keep resolving so a refresh rebuilds **the same result** from the server —
`GET /<code>/round` still returns `podium` and `final_result`, and
`GET /<code>/me` still returns the participant.

The client mirrors this exactly: `WaitingRoomPage` clears the seat on
**`ABANDONED` only**. Treating `COMPLETE` as terminal (which M1's generic
terminal handling did, because `COMPLETE` could not yet mean "the podium
finished") replaced the payoff with a generic ended card at the exact moment it
arrived.

### ABANDONED is the cancellation path

The seat is cleared, the join code stops working (`GET /<code>` →
`410 session_ended`), and every phone is returned to the join screen. No
podium, no final result, nothing that would let a cancelled event masquerade as
a completed one.

---

## 13. Lifetimes, expiry and recovery

Two clocks, because they bound two different mistakes.

| Constant | Value | Measured from | Bounds |
|---|---|---|---|
| `LOBBY_LIFETIME` | 6h | `created_at` (`default_expiry()`) | a join code nobody ever used |
| `LIVE_LIFETIME` | 6h | `started_at` | a running competition nobody finished |

`expires_at` is set to `created_at + LOBBY_LIFETIME` at creation and **renewed
to `started_at + LIVE_LIFETIME` at `START_QUESTION`**.

**Why the renewal exists (M2.6).** `expires_at` used to be set once and never
touched. `active_sessions_for()` filters `expires_at > now()`, so a coach who
opened the lobby before school and ran the competition after practice lost
`GET /active` — the "Return to competition" banner — **while the room was still
mid-question**. Nothing consults the deadline mid-competition, so the room kept
running perfectly; only the coach's route back to the projector disappeared.
Regression-covered by `TestHostRecoveryLifetime` in
`tests/test_competition_rounds.py`.

### Where expiry is actually enforced

- `join()` → `410 session_expired`
- `accepts_joins` → `status in JOINABLE_STATUSES and not is_expired`
- `active_sessions_for()` → excluded from recovery

**Nowhere else.** An expired session does not stop mid-round, and there is no
background worker.

### `expire_stale_sessions()` — dead code, recorded deliberately

`services/competition.py` defines it and its docstring says it is "called
opportunistically". **Nothing calls it** but its own test. That is currently
load-bearing luck rather than a latent bug: it filters on *status not terminal*
rather than *status is LOBBY*, so wiring it up today would mark a **live,
mid-round competition** `ABANDONED`. It is left unwired on purpose. Making it
safe is a design decision, not a defect fix.

### `GET /active` — the recovery endpoint

The **smallest discovery surface that works**. It answers one question — what
is live for me right now.

```json
[ { "id": 8, "join_code": "5Q6CHN", "quiz_id": 12, "quiz_title": "Coverages",
    "status": "QUESTION_OPEN", "participant_count": 12,
    "created_at": "…", "expires_at": "…" } ]
```

- Scoped exactly like `coach_session()`: this coach's sessions, plus the
  organization's if they are an admin. **Never** another organization's, so it
  cannot be used to discover that someone else is running a competition.
- **Non-terminal and unexpired only.** Deliberately not a history page — a
  finished competition is not something to return to, and listing it would turn
  a recovery affordance into a management screen nobody asked for.
- A **count**, not a roster. No participant identities.
- Called on the coach screens where recovery makes sense; **not polled**.

The server owns this because a coach who closes the tab, refreshes, or opens
Peira on the laptop attached to the projector has nothing in storage and may
not remember the code. Recovery cannot come from `sessionStorage`.

`GET /sessions/by-code/<code>` completes the path: the host lobby is addressed
by join code (that is what is on the projector and in the URL bar), but every
other host route takes a session id and the public lobby payload deliberately
carries none. Ownership is not relaxed to make that convenient — it goes
through the same `coach_session()` check, so the join code reveals nothing it
did not already reveal publicly.

---

## 14. The poll contract

### `GET /<code>/state` (public) and `GET /sessions/<id>/state` (JWT)

Identical payload, from `CompetitionSession.poll_state()`. **Twelve scalars,
one indexed row, one SELECT, zero writes.**

```json
{ "version": 14, "status": "QUESTION_OPEN", "server_now": "…",
  "current_round": 2, "total_rounds": 10,
  "question_opened_at": "…", "question_closes_at": "…",
  "participant_count": 12, "answered_count": 9,
  "all_in": false, "answering_open": true, "podium_step": 0 }
```

**A count and nothing else about people.** No names, no player ids, no
participant ids, no tokens, no roster. Adding any of those would turn the cheap
poll into the expensive one and publish identities to anyone holding the code.

**Still one query.** `participant_count` and `answered_count` are
`column_property` correlated subqueries inlined into the same SELECT that loads
the session — not extra round trips, and not a lazy load of the participants
collection. Measured plan: Index Only Scan on the FK's existing index, 0.069 ms.
`test_the_poll_issues_one_query` asserts it.

### What changes `version`

- every applied transition (`session.bump()` in `transition()`)
- a participant **joining** (the lobby list changed)
- a participant being **removed**
- `end_session()`

### What does NOT change `version`

- **an answer submission.** Explicitly not bumped — a submission is a counter
  moving, not a structural change. Bumping would make every phone in the room
  refetch heavy state on every tap, which is the stampede the M1 load harness
  caught.
- **the clock running out.** `answering_open` flips to `False` with no
  transition and no bump.
- `all_in` becoming true.
- `last_seen_at` being stamped.

**Counters ride the poll; `version` marks structural change.** This is why
`answered_count`, `all_in` and `answering_open` must be read from the poll and
**not** from the version-gated payload. Reading them from the host view left
the projector frozen on "ANSWERS LOCKED" with 28 seconds still on the clock —
found only by a live walkthrough.

### Polling expectations

- **1 Hz**, via a self-correcting `setTimeout` chain, **not `setInterval`** —
  the latter queues another call whether or not the last one finished, turning
  one phone on a bad connection into a backlog of overlapping requests.
- Consecutive failures back off 1 → 2 → 4 → 8s; the first success returns to
  1 Hz immediately. **The last good state stays on screen throughout.**
- During `QUESTION_OPEN`/`QUESTION_REVEAL` the ceiling is **2s**, not 8s: a
  phone eight seconds behind a twenty-second countdown would discover the
  question had closed while still showing time remaining.
- The heavy payload is fetched **on mount and on version change only**,
  coalesced to at most one per **2s** per client. Thirty players joining bump
  the version thirty times; a naive fetch-on-every-change is 30 × 30 = 900
  roster fetches in the join window. Coalescing also makes it independent of
  arrival rate — ten joins in one second produce one fetch. A change arriving
  inside the window sets a dirty flag, so the roster always converges.
- A poll is issued immediately on `visibilitychange` → visible, so a phone that
  slept through part of a question does not wait up to a second to find out.
- Polling **stops** on `404` and `410` (`onFatal`) — retrying cannot fix
  either. `401` stays retryable.

### Rate limits

Keyed by **join code or acting player, never by IP** — a whole team shares one
Wi-Fi NAT, and an IP-keyed limit would treat thirty players as one abusive
client and lock the room out of its own competition.

| Route | Limit | Key |
|---|---|---|
| `GET /<code>/state` | **none** | — the heartbeat is cheaper than the 429 would be |
| `GET /<code>` | 1800/min | join code |
| `POST /<code>/join` | 30/min | `code:player_id` |

1800/min is arithmetic, not a guess: the first version was 240/min and the load
harness produced **150 rate-limited players in a thirty-player room** — the
feature limiting itself out of its own lobby. Nothing global is loosened;
`default_limits` is empty and stays that way.

---

## 15. Public player endpoints

### `GET /<code>` — the lobby

`410 session_ended` if terminal. Otherwise:

```json
{ "join_code": "5Q6CHN", "status": "LOBBY", "version": 3,
  "quiz_title": "Coverages", "question_time_seconds": 20, "server_now": "…",
  "roster": [ { "player_id": 41, "display_name": "Ada Lovelace", "taken": true } ],
  "participants": [ { "id": 7, "display_name": "Ada Lovelace" } ] }
```

The roster is an **identity picker over canonical ids** — no free-text name
box, so a player cannot invent an identity or claim someone else's. Eligibility
is the organization's active players, optionally narrowed to the chosen groups;
deactivated players are excluded.

### `POST /<code>/join` → `200`

```json
{ "player_id": 41, "reconnect_token": "…optional, only when retrying…" }
```

Response — **the only response that ever contains a token**:

```json
{ "participant": { /* to_dict(), no token */ },
  "reconnect_token": "…", "join_code": "5Q6CHN", "status": "LOBBY", "version": 4 }
```

| Condition | Status | `reason` |
|---|---|---|
| session terminal | `409` | `session_ended` |
| session expired | `410` | `session_expired` |
| player not on the roster | `404` | `not_eligible` |
| seat taken, token absent or wrong | `409` | `identity_taken` |
| seat free but status ≠ `LOBBY` | `409` | `already_started` |

**Idempotent for the holder of the seat, and only them.** A double-tap or a
refresh lands back in the same seat *if* the matching token is presented
(`compare_digest`). Without it the answer is `409`, not the participant record
— handing the seat back would be identity takeover, and in M2 it would mean
answering on someone else's behalf. A genuine race that loses the unique
constraint converges on the same `identity_taken`.

The seat is also protected by a database `UniqueConstraint(session_id,
player_id)`, so a second phone cannot mint a second identity whatever the
client believes.

### `POST /<code>/answer` → `201` — token required

```json
{ "round_index": 2, "option_id": 91 }
```

**Note what is absent**: no `participant_id`, no `player_id`, no `is_correct`,
no `response_ms`, no points. Those are not "ignored" — there is no field for
them, so there is nothing to tamper with.

Response — **only that it was accepted, and what was chosen**:

```json
{ "accepted": true, "locked": true, "round_index": 2,
  "selected_option_id": 91, "status": "QUESTION_OPEN", "version": 14 }
```

Never whether it was right, never the correct option, never the explanation,
never the points. A phone that knew the answer before the room did would leak
it to anyone standing nearby.

| Condition | Status | `reason` |
|---|---|---|
| missing/unknown token | `401` | `missing_token` / `invalid_token` |
| session terminal | `409` | `session_ended` |
| status ≠ `QUESTION_OPEN`, or no window, or still in the lead-in | `409` | `not_started` |
| `round_index != current_round` | `409` | `wrong_round` |
| past `closes_at + 750ms` | `409` | `answering_closed` |
| the round's question no longer exists | `409` | `no_such_round` |
| question type not scoreable live | `422` | `unsupported_question` |
| option belongs to a different question | `422` | `option_mismatch` |
| already answered this round | `409` | `answer_locked` |

`option_mismatch` is checked against **the frozen round's question**, not
against whatever the client claims to be answering — that is the obvious way to
try to smuggle in a known-correct answer.

### `GET /<code>/round` — token required

See §7. Stamps `last_seen_at`.

### `GET /<code>/me` — reconnect, token required

Addressed by **token, never by player id**. A previous version took the player
id in the path and authenticated with `(join_code, player_id)` — both public,
so it authenticated with nothing at all. It is gone and must not return.

```json
{ "participant": { /* to_dict() */ }, "status": "QUESTION_OPEN",
  "version": 14, "server_now": "…",
  "answer": { "answered": true, "selected_option_id": 91, "round_index": 2 } }
```

`answer` carries **no verdict** — so a refresh mid-question returns to a locked
screen rather than an answerable one, without leaking whether the locked answer
was right.

---

## 16. The frozen question order

`START_QUESTION` snapshots `question_order` — the ids of every question in the
quiz whose type Competition can score — onto the session.

- Taken at the **first question**, not at session creation, because a coach may
  legitimately fix a typo between opening the lobby and starting. Never again
  after that: from there on, a round number has to keep meaning the same
  question.
- Unsupported types are **filtered**, not assumed absent — the quiz can be
  edited in the window between creating the lobby and starting.
- Empty result → `422 no_playable_questions`.
- `total_rounds = len(question_order)`.

If a coach **deletes** a question mid-competition, the frozen order is
deliberately **not** rewritten — it is the historical record of what this
competition was built to play. `playable_round_from()` steps over the hole when
advancing, so `current_round` can never point into a gap and later rounds still
play the questions they always would have. What is lost is only the deleted
round itself.

---

## 17. Analytics isolation — structural, not a filter

Competition writes to **three tables and no others**:
`competition_sessions`, `competition_participants`, `competition_answers`.

A `CompetitionAnswer` is **not** an `answers` row. Competition answers carry
response latency and points, are never hand-graded, and must never reach an
official report. Keeping them in their own table makes that structural rather
than a filter somebody has to remember.

Verified at M2.6: `services/player_analytics.py`, `services/export.py` and
`services/attempts.py` contain **zero** references to Competition. Nothing in
the ordinary Peira flow — attempts, grading, the Results tab, the PDF, the CSV,
the analytics page — can see a Competition, and nothing in Competition writes
an `attempt`, an `answer`, or an `access_code`.

The grading vocabulary and `score = correct / (correct + incorrect)` rule
(`CLAUDE.md` §4) belong to ordinary quizzes. Competition uses Model D and does
not participate in it.

---

## 18. Stable error semantics

Every refusal carries a `reason` so clients branch on a **code**, not on
English. The English may be rewritten; these must not.

| `reason` | Status | Raised by |
|---|---|---|
| `invalid_code` | 404 | `session_by_code` |
| `not_eligible` | 404 | `join` |
| `session_ended` | 409 / 410 | `join`, `submit_answer`, `transition` (409); `GET /<code>` (410) |
| `session_expired` | 410 | `join` |
| `identity_taken` | 409 | `join` |
| `already_started` | 409 | `join` |
| `missing_token` | 401 | `participant_by_token` |
| `invalid_token` | 401 | `participant_by_token` |
| `not_started` | 409 | `submit_answer` |
| `wrong_round` | 409 | `submit_answer` |
| `answering_closed` | 409 | `submit_answer` |
| `answer_locked` | 409 | `submit_answer` |
| `no_such_round` | 409 | `submit_answer`, `_open_question` |
| `option_mismatch` | 422 | `submit_answer` |
| `unsupported_question` | 422 | `submit_answer` |
| `unsupported_questions` | 422 | `create_session` |
| `no_playable_questions` | 422 | `_freeze_question_order` |
| `unknown_action` | 422 | `transition` |
| `stale_transition` | 409 | `transition` — carries `details: {current_version, status}` |
| `illegal_transition` | 409 | `transition` — carries `details: {status, action}` |
| `podium_finished` | 409 | `ADVANCE_PODIUM` |

**`404`, never `403`, throughout the coach surface** — a `403` confirms the
resource exists. **`401` with one message** for both a wrong token and a
removed seat — distinguishing them would confirm which tokens exist.

---

## 19. What Competition deliberately does not do

- **No WebSockets or SSE.** Polling, by design.
- **No background worker.** Nothing fires on a timer; the coach moves the room.
  The single time-driven behaviour is `answering_open` flipping to `False`,
  which changes no state and bumps no version.
- **No late joiners.** `JOINABLE_STATUSES = (LOBBY,)`.
- **No mid-competition participant removal.** LOBBY only.
- **No per-question timing.** One session-level setting.
- **No history page.** `GET /active` is recovery, not management.
- **No `FILL_BLANK`, `WRITTEN`, or `DRAW_RESPONSE`.**
- **No hidden tiebreakers.** Ties are real and are displayed as ties.
