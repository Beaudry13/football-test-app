# Player Home and player continuity

Status: **design plus reversible groundwork** (build-first-2, 2026-10-20). Nothing in this document changes authentication.

## The question

A player should be able to open PEIRA and see *what do I need to do next?* without digging up an old link or code.

## How a player is identified today

- **Per code:** a player is a **code plus a name**. With PIN security on, he is a code plus `player_id` plus a PIN, which proves him for **one attempt**: `/api/play/claim` issues an **attempt token** bound to that single attempt (`services/attempt_tokens.py`).
- **No player-wide session:** there is **no player-scoped session**. Nothing proves "I am Marcus Hill" across codes. The coach JWT is the only principal-level session in the app.
- **Device memory:** the device remembers, **per code**, who played (`peira.play.session.v1:{CODE}`) and that attempt's token (`peira.attempt.token:{CODE}:{playerId}`).
- **No reverse lookup:** nothing on the server answered "which live codes is this player on?". `services/access_codes.py` only goes from a code to its players.

## What build-first-2 adds (reversible, no auth change)

1. **Player Home on `/play` (device-scoped).**
   - Built from the codes this device has played. Each one is re-checked with the public `/validate-code`, so a closed or unknown code is never offered.
   - Ranked (as built in build-first-2): a retest Rep first, then Reps, then quizzes, then Review missed. Superseded by build-first-3's order below.
   - One item leads ("Up next"); the rest sit under "Also waiting"; a new code is always one box away.
   - With nothing on the device, `/play` is exactly the code screen it always was.
   - Code: `pages/play/MyWork.tsx`, `pages/play/workProgress.ts`.
2. **Device progress per code** (`peira.play.progress.v1:{CODE}`). Written as the player plays: *started* on entering, *done* with the misses on finishing. A finished run with misses offers **Review missed** (`/play/CODE?review=1`), which opens his last run on the exact pictures without starting a new run (`HomeReview.tsx`).
3. **Server groundwork: `services/player_assignments.open_assignments(player)`.**
   - Lists the live codes a player may use now, by the **same rule the name picker uses** (`selectable_players_for_code`), with his own status on each.
   - Read-only and tested; **no route serves it**.

## What build-first-3 adds (still reversible, no auth change)

1. **A graded quiz's misses stay on Home.** After submitting, his results page reports how many he missed; the progress record says the quiz was graded, and Home offers **Review missed (N)**, opening his results page (`/results/CODE/NAME?player_id=…`, the link the finish screen bookmarks). Nothing missed: it drops off, as before.
2. **Results lead with "What you missed"** on the football picture each question was asked on (the delivered one), with his answer and the correct one in words. The answer-reveal policy is unchanged: graded results still carry no per-option correctness and no question explanation.
3. **"Work on: …"** on Up next when it is a review: the concepts of the missed questions, in the coach's words (read from what `/validate-code` already returns).
4. **"You're all caught up."** when every code on the device is done with nothing to review.
5. **The code box is second once the device has played** ("Got a new code?", no autofocus - on a phone the focus popped the keyboard over Up next). A never-used device still opens on the code box, titled "Enter your code".

6. **Try the misses again** (Reps and practice quizzes only). Review Missed ends on it; the finish screen offers it after "Review missed", with the whole run again kept as a quiet link. It is a new PRACTICE attempt through the same `/start` / `/claim` path (`retry_of_attempt_id`, migration `b6e2d8f41a07`): the server reads the misses from HIS finished practice run on that code, delivers exactly those, and leaves the retry out of every run-level Rep reading. The original run is never touched. A graded attempt is never retried from the player's side - assessment stays assessment; reteaching goes through Teach / Rep / Retest.
7. **Order on Home** (owner's hierarchy): a retest, then his own misses (Review missed, or a retry in progress - "Your misses, again"), then an assigned Rep, then an assigned quiz (graded before practice).

**Limits of the device-scoped home:**
- It only knows codes played **on this device**. A new phone starts empty, and work sent but never opened on this device isn't listed.
- Removing it is deleting the two localStorage prefixes and the UI; no server state depends on it.

## Recommended design for real continuity: a "player pass"

A long-lived, **player-scoped**, revocable credential, issued only after a player proves himself with his PIN.

| | |
|---|---|
| Issue | On a successful `/api/play/claim` with a PIN (never on a name alone, never with a token alone), also issue a player pass: 32 random bytes, returned once, stored only as a SHA-256 hash. |
| Store | New table `player_passes`: `id`, `player_id` (FK), `token_hash`, `pin_version` at issue, `created_at`, `last_used_at`, `expires_at` (for example 60 days, sliding), `revoked_at`, `device_label`. This is an **additive migration**. |
| Bound to | The player **and** his current `pin_version`. A PIN reset (which already bumps `pin_version`) revokes every pass, the same way it revokes attempt tokens today. |
| Use | `GET /api/play/my-work` with `X-Player-Pass` returns `open_assignments(player)`, plus what to review from his latest attempts (server-side, so it works across devices). Starting work from Home still goes through `/claim`, which may accept the pass in place of the PIN for **that player's own** codes. |
| Revoke | A PIN reset; a coach-side "sign this player out everywhere"; expiry. |
| Requires | Organization PIN security **on**. A player without a PIN never gets a pass, and the device-scoped Home stays the experience for orgs without PIN security. |

**Security review needed before building any of it:**
- **Token theft on shared phones.** The pass sits in localStorage, so XSS impact grows: a stolen pass reads one player's assignments and progress for its lifetime. Mitigations: short sliding expiry, a device list visible to the coach, revoke-all on PIN reset, and no grades in `/my-work` beyond his own.
- **Enumeration.** `/validate-code` already lists `roster_players_v2` with `player_id`s publicly for a live code (an existing design choice). A pass must never be obtainable from an id alone; it needs the PIN.
- **Rate limits** on `/my-work` and on pass-accepting `/claim`.
- **Answer-reveal policy is unchanged:** `/my-work` returns no correct answers for quizzes. A Rep's review may carry the right answer, as the Rep itself now does.

**Rollout:** behind a config flag (like `PLAYER_PIN_ENFORCEMENT`), backend first, then the frontend reads `/my-work` when a pass is present and falls back to the device-scoped list otherwise.

## Decisions for the owner

1. Approve building the player pass (auth work, so it needs its own security review and PR).
2. Pass lifetime and a coach-visible device list.
3. Whether orgs without PIN security should get any cross-device home at all (today: no, by design).
