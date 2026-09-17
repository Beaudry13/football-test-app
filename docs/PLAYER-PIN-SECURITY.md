# Player PIN security

**Status:** code complete on `security/player-pin-completion`. **Enforcement is OFF**
(`PLAYER_PIN_ENFORCEMENT` unset) and nothing in this document is live in production
until the rollout below is deliberately run.

**The problem it solves:** without it, a player can pick a teammate's name and start,
answer, submit or read results as that teammate.

---

## 1. The model

| Piece | What it is |
|---|---|
| **PIN** | 6 random digits per canonical player, issued by Peira, never chosen by a coach. Stored only as a bcrypt hash (`player_credentials.pin_hash`, cost `PIN_BCRYPT_ROUNDS`, default 10). Shown once, to the coach who issued it. |
| **Attempt token** | 32 random bytes, issued for ONE attempt when a PIN is proved. Only its SHA-256 is stored (`player_attempts.token_hash`). Sent by the player's device as `X-Attempt-Token`. Carries the PIN version it was issued under. |
| **Reset** | New PIN, `pin_version + 1`, throttle cleared. Every token issued under the old version is refused (`token_revoked`). No attempt is touched. |
| **Throttle** | Per player, never per IP. 5 free wrong PINs; then waits of 1, 2, 4, 8, 15 min (a correct PIN is refused during a wait); an hour without a wrong PIN clears the run; 50 wrong in the credential's fixed 24-hour window locks it until a coach resets. `/claim` and `/results` share it. |
| **Secured code** | Enforcement on AND (`activated_at >= PLAYER_PIN_CUTOVER_AT` OR now `>= PLAYER_PIN_COMPAT_UNTIL`). Uses `activated_at`, never `expires_at`. |

The switch is **temporary**: it exists for a controlled cutover and emergency rollback, and
is removed (with the compatibility code) once hard cutover is proven.

## 2. What each phase built

| Phase | Where | What |
|---|---|---|
| 0-1 | `master` (9b01166) | Credential table + migration `e5b2c8a41f73`, coach PIN tools (Team → Players status, Generate missing PINs, Reset PIN, one-time PIN sheet), gunicorn threads |
| 2 | `master` (6e59ad3) | Tokens, `/play/claim`, per-player throttle |
| 3a | `master` (4ee420e) | Config + startup validation, secured codes, token checks on `/answers`, `/check`, `/drawing`, `/submit`, player-safe `/submit` body |
| 3b | a13ecfa | Name-only `/start` and `/results` fences, results by PIN or token, `/results/identities` |
| 3b review | de4ad33 | `/results/identities` returns the code's ROSTER - it no longer reveals who has submitted |
| 3c | 45f560c | Activation PIN gate |
| 3d | this branch | Player screens: PIN entry, Continue as, token headers, auth-aware saves, results login; coach activation blocker |

**No migration after `e5b2c8a41f73`**, which is already in production.

## 3. Who may do what, with enforcement ON

| Request | Canonical player | Free-text (legacy) name |
|---|---|---|
| `/start`, new attempt | Refused with `401 pin_required` if protected; the player proves it through `/claim` | Allowed only if the name matches NO canonical player on this code's roster (current name or roster snapshot name); one match → `pin_required`, several → `409 pick_player` |
| `/start`, resume | Only while the compatibility rules exempt the attempt; else `pin_required` (before anything reveals whether it was submitted) | An existing legacy attempt under that exact name resumes |
| `/answers`, `/check`, `/drawing`, `/submit` | Row-locked; token checked against the locked row | No token |
| `/claim` | PIN (throttled) or the device's token | `409 legacy_attempt` |
| `/results` | Token for the returned attempt, or PIN (re-issues the token); else `pin_required` | Name only, legacy attempts only |
| `/results/identities` | The code's roster - identical whoever has started, finished, set a PIN, been issued a token, been locked or deactivated | same |
| Activation | Refused (`422 players_need_pins`, names listed) while any ACTIVE canonical player on the targeted roster has no PIN | Free-text entries never block |

"Protected" = enforcement on AND (secured code OR the player has a PIN OR the player was
ever issued a token under this code). Cross-organization players and codes are refused
before any PIN is evaluated.

## 4. The player experience (frontend)

**The frontend reads no flag.** It follows the server: with enforcement off `/start` never
answers `pin_required`, so no player ever sees a PIN screen. Switching enforcement on or off
needs no frontend deploy.

| Moment | What the player sees |
|---|---|
| Open a code | Choose your name (jersey/position shown when names collide) |
| Protected | Enter your PIN (6 digits, number keypad, checked on the 6th digit) → quiz |
| Wrong PIN | "Incorrect PIN. Try again." |
| 6th wrong / wait | "Incorrect PIN. Too many attempts. Try again in 1 minute." / "Too many attempts. Try again in N minutes." |
| Locked | "Too many attempts. Ask your coach to reset your PIN." |
| No PIN yet | "You don't have a PIN yet. Ask your coach." |
| Refresh, same tab | Straight back into the quiz |
| New tab / next day, same device | "Continue as Jordan Smith · #7 · QB" (one tap, no PIN) or "Not you? Choose your name" |
| Coach reset the PIN mid-quiz | "Your PIN was changed. Enter your new PIN to keep going." - unsaved text/choice answers are kept and re-saved |
| Continued on another device | "You continued on another device. Enter your PIN to keep going here." |
| After submit | Results open with the device token |
| Results later, another device | `/results` → code → Choose your name → PIN (only if required) |
| Code expired | "Already played it? View your results" |

Device storage (never the PIN): `peira.attempt.token:{CODE}:{playerId}`,
`peira.play.session.v1:{CODE}` (the remembered player), and sessionStorage
`peira.play.active.v1:{CODE}` (the open-quiz marker that makes a refresh seamless).

**The shared-phone rule:** a stored token is used only for the player the device remembers,
reached by tapping "Continue as". Tapping a name in a list never uses one. Remembering a
player deletes every other player's token for that code; "Not you?" deletes the remembered
player and their token.

## 5. Compatibility with existing attempts

| Attempt | Enforcement off | Enforcement on, code activated BEFORE cutover, before COMPAT_UNTIL | Code activated after cutover, or any code after COMPAT_UNTIL |
|---|---|---|---|
| Canonical, in progress, never tokened, player has **no PIN** | unchanged | continues without PIN or token | `pin_required`; the player cannot continue until a coach gives them a PIN |
| Canonical, in progress, never tokened, player **has a PIN** | unchanged | next write `token_missing` → PIN → same attempt resumes, answers intact | same |
| Canonical attempt that **has a token** | token ignored | token required | token required |
| Canonical, submitted | results by player id, as today | results need token or PIN if the player has a PIN / was tokened; else as today | results need token or PIN |
| Legacy free-text (`player_id IS NULL`) | unchanged | unchanged, inside the name fences | unchanged, inside the name fences |
| PIN reset | tokens revoked (only checked when on) | tokens revoked | tokens revoked |

Historical results and scores are never changed by any of this: no attempt, answer,
snapshot or grade is rewritten. A PIN or token only decides who may READ or WRITE.

## 6. Rollout plan (not started)

1. **Deploy the backend** (3b + 3c) with enforcement OFF. No migration. Players see nothing
   different; results by name keep working.
2. **Deploy the frontend** (3d). With enforcement off, players still never see a PIN screen;
   the Results page gains the name picker.
3. **Measure** a PIN check on Render (bcrypt cost 10) under a burst.
4. **Coaches issue PINs** (Team → Players → Generate missing PINs; print the sheet) and hand
   them out. Watch the "players don't have a PIN" banner reach zero.
5. **Owner-approved production smoke plan** - see §9; decide the test identity first.
6. **Set** `PLAYER_PIN_CUTOVER_AT` (a moment just before step 7) and `PLAYER_PIN_COMPAT_UNTIL`
   (cutover + 7 days, at most 14), then `PLAYER_PIN_ENFORCEMENT=true`. A bad configuration
   fails startup loudly rather than booting half-secured.
7. **Watch** the window: 401/423/429 rates on `/play/*`, coach resets, activation refusals.
8. **After COMPAT_UNTIL**, read-only check that no pre-cutover code is still active, then a
   separate change removes the switch and the compatibility code.

## 7. Rollback

| Problem | Action |
|---|---|
| Enforcement causes trouble | Set `PLAYER_PIN_ENFORCEMENT=false` (Render restarts). Every route behaves as before; PINs and tokens are kept, unused. |
| Frontend problem, enforcement off | Roll back the frontend alone. |
| Frontend problem, enforcement on | Turn enforcement off first, then roll back the frontend - the old frontend cannot enter a PIN. |
| Backend problem | Turn enforcement off; roll back the frontend BEFORE rolling the backend back past 3b (the new Results page needs `/results/identities`). |
| Abandon PINs entirely | Enforcement off is sufficient. Dropping the credential table is a separate, destructive decision. |

## 8. What changes the moment enforcement turns on

- New attempts on codes activated after cutover need a PIN (or a device token).
- A player with a PIN needs it (or a token) on EVERY code, old ones included.
- Name-only starts and name-only results stop reaching canonical players.
- Writes to protected attempts without a valid token are refused before "already submitted"
  can leak.
- Results for protected players need a token or PIN.
- Activation refuses while an active roster player has no PIN.
- After `COMPAT_UNTIL`, every code is secured.

Nothing about questions, grading, exports, coach screens, Competition or historical data
changes.

## 9. Production smoke (decide before step 6)

A PIN flow cannot be proven without a player, a PIN and an attempt, and `CLAUDE.md` forbids
casual production test data. Read-only checks (health, `/play/claim` validation, the served
bundle) come first; the end-to-end check needs an owner decision on WHICH existing
organization, player and quiz to use, recorded before it runs.

## 10. Known limitations

- **Free-text roster names** stay name-only - the documented exception. Link them to the
  Master Roster to protect them.
- **"Continue as" on a shared phone** is one explicit tap; a careless teammate could tap it.
  "Not you?" and the jersey label mitigate, not prevent.
- **Tokens live in localStorage**, like the coach login token: script injection on the site
  would expose them.
- **PIN status is disclosed to anyone who tries a PIN** for a player id (`pin_not_set`,
  `pin_locked`) - worded for the player, of little use to an attacker, recorded honestly.
- **A teammate can deliberately lock a player out** with wrong guesses (bounded by the waits;
  a coach reset fixes it).
- **`/claim` has no IP limiter** (a whole team shares one IP). The per-player throttle bounds
  bcrypt work per player, not across players.
- **The results picker is the roster**: a player removed from every linked group after
  submitting is not offered (their device, a coach re-add, or a typed legacy name still work).
- **No onboarding checklist step** for PINs; the roster banner and the activation gate carry
  that job.
- **Unsaved drawings** across a PIN prompt rely on the device's drawing drafts, not the
  carry-over used for text and choices.
- **No ProxyFix** (pre-existing): the IP-keyed limits may see Render's proxy address.
- **Competition is separate** (§11).

## 11. Competition

Competition does not use `/play` attempts. It seats players by `(join_code, player_id)`
with its own `X-Competition-Token`, so the PIN system neither protects nor breaks it: a
teammate can still take another player's seat in a live, coach-run session. That needs its
own identity phase and is deliberately out of scope while Competition is frozen.
