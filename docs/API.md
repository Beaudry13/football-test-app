# API Reference

Base URL (local dev): `http://localhost:5000/api`

All request/response bodies are JSON unless noted (image and CSV uploads
use `multipart/form-data`). Authenticated endpoints require:

```
Authorization: Bearer <access_token>
```

Errors follow a consistent shape:

```json
{ "error": "Human-readable message", "details": { "field": ["reason"] } }
```

`details` is only present for validation failures (HTTP 422). This shape
is consistent across every error status the API returns, including
infrastructure-level ones like `413` (file too large) and `429` (rate
limited) — those aren't left as raw Flask/Werkzeug text either.

A handful of public, unauthenticated endpoints are rate-limited per IP
(register, login, access-code validation, quiz submission) to make
credential stuffing and access-code brute-forcing impractical. Exceeding
the limit returns `429` with
`{ "error": "Too many requests. Please wait a moment and try again." }`.
See each endpoint below for its specific limit.

---

## Auth

### `POST /api/auth/register`

Rate limit: 10 requests/hour per IP.

Create a coach account.

**Request**
```json
{
  "username": "coach_smith",
  "email": "coach@example.com",
  "password": "at-least-8-chars",
  "organization": "Wildcats Football"
}
```

**Response `201`**
```json
{
  "coach": { "id": 1, "username": "coach_smith", "email": "coach@example.com", "organization": "Wildcats Football", "created_at": "..." },
  "access_token": "..."
}
```

`409` if username or email is already taken. `422` on validation failure.

### `POST /api/auth/login`

Rate limit: 10 requests/minute per IP.

**Request:** `{ "email": "...", "password": "..." }`
**Response `200`:** same shape as register. `401` on bad credentials.

### `GET /api/auth/me` 🔒

Returns the authenticated coach's profile.

---

## Quizzes 🔒

All quiz endpoints are scoped to the authenticated coach — a coach can
never read or modify another coach's quizzes (cross-org requests return
`404`, not `403`, to avoid confirming another coach's quiz IDs exist).

### `GET /api/quizzes`

List the coach's quizzes, most recently updated first. Each item omits
questions (use the detail endpoint for that).

### `POST /api/quizzes`

**Request**
```json
{ "title": "Week 3 Prep", "description": "optional", "one_question_at_a_time": true }
```
**Response `201`:** the created quiz.

### `GET /api/quizzes/{quiz_id}`

Returns the quiz with its full question list, including correct answers
(safe here since this is the coach-only view) — used for both editing and
previewing before activation.

### `PATCH /api/quizzes/{quiz_id}`

Partial update. Accepts any of `title`, `description`, `one_question_at_a_time`,
`folder_id`. Pass `"folder_id": null` to move the quiz back to
"Uncategorized"; `404` if the folder belongs to another coach.

### `DELETE /api/quizzes/{quiz_id}`

`204` on success. Cascades to questions, roster, access codes, and responses.

### `POST /api/quizzes/{quiz_id}/duplicate`

Deep-copies the quiz: questions, options, and any question images/annotations.
Roster and access codes are **not** copied. Returns the new quiz, `201`.

---

## Folders 🔒

Dashboard organization only — a folder groups a coach's quizzes and has no
effect on play. A quiz's `folder_id` is `null` when it's uncategorized.

### `GET /api/folders`

The coach's folders, ordered by name, each with a `quiz_count`.

### `POST /api/folders`

**Request:** `{ "name": "Fall Camp" }` → the created folder, `201`.

### `PATCH /api/folders/{folder_id}`

**Request:** `{ "name": "..." }` — rename.

### `DELETE /api/folders/{folder_id}`

`204`. **Quizzes in the folder are not deleted** — their `folder_id` is set
to `null` (back to "Uncategorized") by the FK's `ON DELETE SET NULL`.

---

## Groups 🔒

Reusable, coach-scoped player lists (e.g. "Varsity", "Defense"), built once
and attached to whichever quiz activations need them — see
`POST /api/quizzes/{quiz_id}/access-codes`. Distinct from a quiz's own
roster, which stays one-per-quiz.

Player-name rules are identical to rosters: trimmed, blanks dropped,
case-insensitive duplicates rejected with `422`.

### `GET /api/groups`

The coach's groups, ordered by name, each with its full `players` list.

### `POST /api/groups`

**Request:** `{ "name": "Defense" }` → the created (empty) group, `201`.

### `GET /api/groups/{group_id}`

A single group with its players. `404` if it belongs to another coach.

### `PATCH /api/groups/{group_id}`

**Request:** `{ "name": "..." }` — rename.

### `PUT /api/groups/{group_id}/players`

**Request:** `{ "players": ["Jordan Smith", "Alex Lee"] }` — replaces the
full member list.

### `POST /api/groups/{group_id}/players/csv`

`multipart/form-data` with a `file` field, same CSV format as the roster
upload. Replaces the full member list.

### `DELETE /api/groups/{group_id}`

`204`. Also unlinks the group from any access codes that referenced it;
those codes then fall back to their quiz's own roster.

---

## Questions 🔒

Nested under a quiz. `question_type` is one of `true_false`,
`multiple_choice`, `written`.

Option rules (enforced server-side, `422` if violated):
- `true_false` — exactly 2 options
- `multiple_choice` — at least 2 options
- both — exactly one option must have `is_correct_answer: true`
- `written` — no options

### `POST /api/quizzes/{quiz_id}/questions`

**Request**
```json
{
  "question_text": "Is this Cover 2?",
  "question_type": "true_false",
  "options": [
    { "option_text": "True", "is_correct_answer": true },
    { "option_text": "False", "is_correct_answer": false }
  ],
  "position": null
}
```
`position` is optional; omitted/`null` appends to the end. **Response `201`:** the created question, including correct-answer flags.

### `PATCH /api/quizzes/{quiz_id}/questions/{question_id}`

Partial update of `question_text`, `question_type`, and/or `options`
(replaces the full option list when provided).

### `DELETE /api/quizzes/{quiz_id}/questions/{question_id}`

`204`. Also deletes any attached image from storage.

### `POST /api/quizzes/{quiz_id}/questions/reorder`

**Request:** `{ "question_ids": [3, 1, 2] }` — must contain every question
in the quiz exactly once (`422` if any id is missing, foreign, or
repeated). Response: the questions in their new order.

### `POST /api/quizzes/{quiz_id}/questions/{question_id}/image`

`multipart/form-data` with an `image` field. Extension must be one of
png/jpg/jpeg/webp (`400` otherwise — checked by extension only, not file
content). Replaces any existing image. **Response `201`:**
```json
{ "id": 1, "question_id": 5, "image_url": "/uploads/<uuid>.png", "annotations": [], "updated_at": "..." }
```

`413` if the file exceeds `MAX_UPLOAD_SIZE_MB` (10MB by default):
`{ "error": "File is too large. Maximum size is 10MB." }`.

### `PUT /api/quizzes/{quiz_id}/questions/{question_id}/image/annotations`

**Request:** `{ "annotations": [ { ...layer objects, shape owned by the frontend drawing tool... } ], "canvas_width": 1400 }`
Replaces the full annotation layer list for the image. `404` if the
question has no image yet.

`canvas_width` is optional and records the canvas pixel width the drawing
tool used, since every saved shape's coordinates are relative to it. Once
set it pins that image's coordinate space, so a later change to the tool's
default canvas size can't shift already-saved shapes. Omitting the field
leaves any previously stored value untouched; `null` on an image means it
predates this field (the frontend then assumes the original 900px).

### `DELETE /api/quizzes/{quiz_id}/questions/{question_id}/image`

Removes the image (file + record). `204`.

---

## Roster 🔒

One roster per quiz; players are picked by name at play time instead of
free-typed, so there's always exactly one canonical spelling per roster.

Both endpoints below share the same validation: names are trimmed of
whitespace server-side, blank names are dropped, and a duplicate name
(case-insensitive) is rejected with `422` rather than silently deduped —
two roster entries for the same name would otherwise let a player
validate but then collide with the one-response-per-player constraint at
submit time.

### `GET /api/quizzes/{quiz_id}/roster`

Returns `{ "id": null, "quiz_id": ..., "players": [] }` if none exists yet.

### `PUT /api/quizzes/{quiz_id}/roster`

Manual entry. **Request:** `{ "players": ["Jordan Smith", "Alex Lee"] }`
— replaces the full roster. `422` if the list is empty (after trimming)
or contains a duplicate name.

### `POST /api/quizzes/{quiz_id}/roster/csv`

`multipart/form-data` with a `file` field. Accepts a CSV with a `name` /
`player_name` / `player` header (case-insensitive), or a single unlabeled
name column. Replaces the full roster. Same duplicate/blank-name rules as
the manual-entry endpoint above; `400` if the file isn't valid UTF-8 CSV
or no names are found.

---

## Access codes 🔒

### `GET /api/quizzes/{quiz_id}/access-codes`

Activation history for the quiz, newest first.

### `POST /api/quizzes/{quiz_id}/access-codes`

"Activates" the quiz: generates a new 6-character code valid for
`ACCESS_CODE_TTL_HOURS` (default 24). Retires any previously active code
for this quiz. Requires the quiz to have at least one question, and either
a non-empty roster or at least one selected group with members (`422`
otherwise).

**Request (optional body):** `{ "group_ids": [3, 7] }` — restricts this
activation to the named saved groups. `404` if any group belongs to another
coach. When groups are linked, they **replace** the quiz's own roster as the
set of players who can join: a name on the quiz roster but not in any linked
group won't appear at join time and is rejected at submit. With no groups
linked, behavior is exactly as before (the quiz's roster is used).

**Response `201`**
```json
{ "id": 1, "quiz_id": 5, "code": "7F9K2R", "activated_at": "...", "expires_at": "...", "is_active": true, "is_valid": true, "groups": [{ "id": 3, "name": "Varsity" }] }
```

### `POST /api/quizzes/{quiz_id}/access-codes/{access_code_id}/deactivate`

Manually retires a code before its natural expiry.

---

## Playing a quiz (public, no auth)

These are the only endpoints a player-facing client calls. No accounts —
identity is the access code plus a name chosen from the roster.

### `POST /api/play/validate-code`

Rate limit: 20 requests/minute per IP (codes are 6 characters from a
31-character alphabet — without a limit here that space is brute-forceable).

**Request:** `{ "code": "7F9K2R" }`
**Response `200`**
```json
{
  "access_code_id": 1,
  "expires_at": "...",
  "quiz": { "id": 5, "title": "...", "one_question_at_a_time": true, "questions": [ /* no correct-answer flags */ ] },
  "roster_players": ["Jordan Smith", "Alex Lee"]
}
```
`404` if the code is invalid, expired, or deactivated.

### `POST /api/play/submit`

Rate limit: 20 requests/minute per IP.

**Request**
```json
{
  "access_code_id": 1,
  "player_name": "Jordan Smith",
  "answers": [
    { "question_id": 10, "selected_option_id": 21 },
    { "question_id": 11, "answer_text": "I set the edge and squeeze the tackle." }
  ]
}
```
True/false and multiple-choice answers are auto-graded immediately
(`is_correct` set from the selected option). Written answers are left
ungraded (`is_correct: null`) pending manual review.

`422` if the player name isn't on the roster, an answer references a
question/option outside the quiz, or `answers` includes the same
`question_id` more than once. `409` if this player already submitted
under this access code — including the case where two submissions for
the same player race each other; the check is enforced at the database
level, not just a pre-check, so this can't be bypassed by concurrent
requests. `404` if the code is invalid/expired.
**Response `201`:** the created response with all answers.

### `POST /api/play/results`

Rate limit: 20 requests/minute per IP.

A player's own graded results — the per-question review shown right after
submitting, and what a bookmarked `/results/:code/:playerName` link on the
frontend re-fetches later. Unlike `validate-code` and `submit`, this does
**not** require the access code to still be valid: a written answer might
not get graded until after the code's normal expiry, so results stay
reviewable past that point.

**Request:** `{ "code": "7F9K2R", "player_name": "Jordan Smith" }`
(player name match is case-insensitive)

**Response `200`**
```json
{
  "quiz_title": "Week 3 Prep",
  "player_name": "Jordan Smith",
  "submitted_at": "...",
  "answers": [
    {
      "question_id": 10,
      "question_text": "Is this cover 2?",
      "question_type": "true_false",
      "your_answer": "False",
      "correct_answer": "True",
      "is_correct": false,
      "coach_feedback": null,
      "graded_at": null
    }
  ]
}
```
`correct_answer` is only populated for `true_false`/`multiple_choice`
(`null` for `written` — nothing single "correct" answer to reveal).

`404` with a generic message if the code doesn't exist or this player
never submitted under it — deliberately the same message either way, so
the response can't be used to enumerate valid codes or roster names.

---

## Grading & dashboards 🔒

### `GET /api/quizzes/{quiz_id}/responses`

All player responses for the quiz, each with its full answer list.

### `GET /api/quizzes/{quiz_id}/responses/{response_id}`

Single response detail.

### `PATCH /api/answers/{answer_id}/grade`

Manually grade an answer (typically a written response) and optionally
attach feedback.

**Request:** `{ "is_correct": true, "coach_feedback": "Nice read." }`
**Response `200`:** the updated answer, with `graded_at` set.

### `GET /api/quizzes/{quiz_id}/dashboard`

Aggregate stats for the quiz's current results.

```json
{
  "quiz_id": 5,
  "roster_size": 22,
  "response_count": 18,
  "response_rate": 0.8182,
  "question_breakdown": [
    { "question_id": 10, "question_text": "...", "question_type": "true_false",
      "answered_count": 18, "correct_count": 15, "incorrect_count": 3, "ungraded_count": 0 }
  ]
}
```

### `GET /api/quizzes/{quiz_id}/export.csv`

Downloads the quiz's results as CSV — one row per player per question
(`Player, Submitted At, Question #, Question, Type, Answer, Correct, Coach
Feedback`), sorted by player name. `Content-Disposition: attachment` with a
filename derived from the quiz title.

### `GET /api/quizzes/{quiz_id}/export.pdf`

Downloads a printable results report as PDF: response-rate summary, the
same per-question breakdown as the dashboard endpoint, and a per-player
score table. Same `Content-Disposition` convention as the CSV export.

### `GET /api/players/history?name=Jordan+Smith`

A player's response history across every quiz belonging to the
authenticated coach — for tracking a player's performance over time.

```json
{
  "player_name": "Jordan Smith",
  "history": [
    { "quiz_id": 5, "quiz_title": "Week 3 Prep", "response_id": 40,
      "submitted_at": "...", "graded_answer_count": 6, "correct_answer_count": 5 }
  ]
}
```

---

## Misc

### `GET /api/health`

Unauthenticated liveness check: `{ "status": "ok" }`.

### `GET /uploads/{filename}`

Serves uploaded question images.
