# Known issues — queued work, reported from real use

This file is **not** the Improvement Bank. Everything in that file was
considered and deliberately deferred. Everything here is a real problem a coach
hit in real use, is approved to be worked on, and is waiting only on sequencing.

**Sequencing: Competition Mode M2 is now FROZEN and production verified
(baseline `4be2069`, see the record at the bottom of this file), so these are
no longer blocked.** They were queued behind it because bouncing between
features is how regressions get made. The owner decides the order; nothing here
should be started without that decision.

None has been investigated yet. Nothing in the "what to check" sections is a
conclusion; they are the questions to answer *before* proposing a fix.

---

## PRIORITY 1 — A coach cannot correct a question on an active quiz

> **READ THIS FIRST — PRIORITY 1 AND PRIORITY 2 ARE ONE PROBLEM.**
>
> Investigated 13 August 2026, code-first. The finding that decides both:
>
> **`answers.is_correct` is a STORED column** (`models/response.py:172`), set
> when the answer is recorded, and every score reads it rather than
> re-evaluating the question. So changing a correct answer does **not**
> retroactively rewrite existing grades - the danger everyone assumes is here
> is not.
>
> What IS true is subtler and worse in a different way:
>
> - **The delivered question is never snapshotted.** `answers` holds
>   `question_id` and `selected_option_id`, both pointing at LIVE rows. Edit the
>   text and the Results screen shows an old answer against a question the
>   player never saw. The evidence of what was actually asked is gone.
> - **Two cohorts, two rules.** Fix a correct answer mid-flight and players who
>   answered before are graded by the old rule, players after by the new one,
>   with nothing recording that the rule changed.
> - **Deletion destroys evidence.** `answers.question_id` is
>   `ON DELETE CASCADE`, so deleting a question deletes the answers to it.
>   `selected_option_id` is `ON DELETE SET NULL`, so replacing options detaches
>   what the player chose while keeping their grade - a grade with no visible
>   basis.
>
> **Both features want the same missing concept: an immutable record of what
> was delivered, separate from the authoring state.** PRIORITY 1 needs it so a
> correction does not rewrite history; PRIORITY 2 needs somewhere to mark
> "excluded" that is not the live question. The Competition
> immutable-question-snapshot entry in IMPROVEMENT-BANK.md is the third face of
> it, and `question_order` already solves the ORDERING half of that problem
> while leaving the CONTENT half open.
>
> This is an argument for designing them together, **not** for building a
> versioning system first. The minimal shapes worth pricing are (a) snapshot
> the delivered question onto the answer/attempt, or (b) copy-on-write a new
> question version when an answered question is edited, leaving old answers
> pointing at the old version. Both are schema changes and neither should be
> chosen without the owner.

**Status: reported, uninvestigated. This is a product gap, NOT simply a bug -
the restriction exists for a good reason and must not just be removed.**

### What happened

A coach sent a test to a group, then noticed one question contained an error.
Players had already started. Peira refused the edit.

The refusal is defensible: a coach silently changing a question underneath
players who already answered it could corrupt attempts, grading, results,
analytics, historical accuracy, explanations and drawings. **Do not "fix" this
by unlocking editing.**

But the current behaviour traps the coach. A typo, wrong wording, a mislabelled
option, a wrong correct-answer or a bad image is a legitimate thing to need to
fix mid-flight, and "you cannot edit this question" is not an acceptable final
answer.

### The product principle

> Peira should protect assessment integrity without trapping the coach when a
> real mistake needs correcting.

The eventual UX should be an intentional, informed override rather than a wall.
Direction only - not a specification:

    THIS QUIZ HAS ACTIVE ATTEMPTS

    Changing this question may affect players currently taking the quiz.

    [Cancel]  [Review correction options]

### Trace the data model BEFORE designing anything

1. What exactly prevents the edit today.
2. Whether the lock keys on active access codes, started attempts, submitted
   attempts, existing responses, quiz status, or something else.
3. Which fields are protected, and which are not.
4. What would happen to existing attempts if each field changed.
5. Whether answers and results reference question ids, option ids, positions,
   snapshots, or live question data. **This is the load-bearing question** - if
   grading reads live question data, changing a correct answer rewrites
   history; if it reads a snapshot, it does not.
6. Whether a correction could safely apply only to players who have not yet
   reached that question.
7. Whether historical attempts need a frozen snapshot of the original question.
8. What a player currently looking at that question sees when it changes.
9. What happens on refresh or reconnect.
10. What happens to grading when the correct answer itself changes.

### Not all corrections carry the same risk

Investigate these as separate cases rather than one rule:

- **A. Cosmetic** — typo in the question text, tidier wording
- **B. Question content** — meaning-changing rewrite
- **C. Answer choices** — editing, adding or removing an option
- **D. The correct answer** — the highest-risk case by far
- **E. Images** — replacing or removing one

A and E may be safe with little more than a warning. D almost certainly needs a
regrade decision, and possibly a snapshot. Do not collapse them into a single
permission.

### Related work already recorded

The Competition M2.2 note in `IMPROVEMENT-BANK.md` raises the same underlying
question from the other direction: whether a competition needs immutable
question snapshots so results stay explainable after a quiz is edited. If
Priority 2 concludes that attempts need snapshots, the two should be designed
together rather than twice.

### Reporting expectation

Report the full investigation - root cause, what could be corrupted, safe
versus dangerous edits, the recommended override model, how existing,
in-progress and completed attempts behave, and any migration - and **stop for
approval before implementing the override.**

---

## PRIORITY 2 — "Don't count this question"

**Status: requested by the owner, approved as work, not designed, not
investigated.** Recorded 13 August 2026 during the Competition M2 freeze,
because until now it existed only in conversation.

### What the coach wants

Players point out after the fact that a question was confusing, misleading,
badly worded, or simply wrong. The coach wants to mark it

> **DO NOT COUNT THIS QUESTION**

and have it drop out of the effective result — **without** deleting attempts,
deleting the quiz, or hand-editing anybody's score.

The original responses must **remain stored** for audit and history. This is an
exclusion from scoring, not a deletion of what happened.

### Why this is not a small change

Peira states its grading rule in exactly one form —
`score = correct / (correct + incorrect)`, never counting ungraded or
unanswered — and that rule is implemented **twice on purpose**, in
`services/export.py` and in the player-analytics path, with a note in CLAUDE.md
that changing one without the other makes the PDF, the CSV, the Results tab and
the analytics page disagree with each other. An excluded question changes the
DENOMINATOR, so it lands on precisely that shared rule. Any design that
implements exclusion in one of those places has already failed.

### Decide these BEFORE writing code

- **Scope.** Is exclusion per-quiz, or per-access-code/assignment? A question
  that was broken for one group may have been fine for another.
- **Denominator.** Excluded questions must leave both numerator and denominator
  — "9/10 with one excluded" is 9/9, not 9/10 and not 90%.
- **Pass/fail and thresholds**, wherever they are derived from the percentage.
- **Every surface that reports a score**: Results tab, player profile/history,
  cumulative performance PDF, CSV export, analytics. All of them, or the
  product contradicts itself.
- **Reversibility.** Can a coach un-exclude? Almost certainly yes — the whole
  point is that this is a judgement call — which means it cannot be modelled as
  a destructive edit.
- **Auditability.** Someone must be able to see later that a question was
  excluded, by whom and when. `GradeAuditLog` already exists; check whether it
  is the right home before inventing a second mechanism.
- **Visibility to players.** Does a player's already-seen result silently
  change? A score that moves with no explanation is its own problem.
- **Competition Mode is NOT in scope.** Competition uses Model D and its own
  tables, deliberately isolated from ordinary attempts. Excluding a question
  there would mean restating a result a room already watched happen, which the
  design explicitly refuses. Keep this feature on the ordinary quiz path.

### Relationship to the other two

This is the *third* thing the same underlying gap produced: a coach who finds a
mistake after players are already in has no safe move. PRIORITY 2 is "let me
fix it going forward", this is "let me neutralise it after the fact". They
should probably be designed together, or at least sequenced deliberately, since
a coach hitting a bad question will reach for whichever exists.

---

## The Competition Mode M2 baseline

**Competition Mode M2 is FROZEN and production verified as of 13 August 2026.**

| Milestone | SHA |
|---|---|
| M1 | `ade50fb` |
| M2.1 round state machine | `beda880` |
| M2.2 answering + scoring | `3dc567e` |
| M2.3 live question + reveal | `632a02f` |
| M2.4 standings + rank movement | `dc840d4` |
| M2.5 podium + final standings | `36f5629` |
| M2.6 cross-milestone hardening | `41eb745` |

Approved production fixes made during verification:

| Fix | SHA |
|---|---|
| Join code sized from its card, not the viewport | `edcfa70` |
| Scan-to-join QR | `32588d8` |
| Finish Competition before the questions run out | `4be2069` |

**Production-verified baseline: `4be2069dd5cba3244021c2f5ef43a86ca762117f`**
(= `origin/master` at the time of the freeze).

Verified against the real deployed frontend and backend, with a coach laptop
and a physical phone on a real network: QR join, lobby and live arrivals, the
3-2-1 lead-in, server-authoritative timing, answering and locking, ALL IN, the
reveal with **no flicker observed under real network conditions**,
explanations, the leaderboard, an intentional early FINISH, FINISH → PODIUM,
podium progression through third/second/first, final standings, COMPLETE, the
player's final result surviving COMPLETE, a refresh at COMPLETE rebuilding the
same result, recovery disappearing after COMPLETE, and ABANDONED remaining
distinct from COMPLETE.

Both M2.6 lifecycle defects — COMPLETE preserving the player's result, and
`/end` never masquerading as a completion — are confirmed fixed **in
production**.

One qualification recorded honestly: **analytics isolation was verified locally,
not against production**, because that check needs coach authentication.
Locally a fully completed 30-player competition produced 285 competition
answers and zero attempts, answers or access codes, and the winner still reads
`completed_count = 0` in ordinary Peira.

## RESOLVED — Duplicating a quiz lost its images

**STATUS: FIXED AND PRODUCTION VERIFIED** (13 August 2026).
**FIX COMMIT: `0f146bdb177ecc5dc06b900bfa394c8e05d8a225`**

### Root cause

Duplicate Quiz created separate database ROWS but both quizzes referenced the
SAME underlying image storage object - `image_url` was copied verbatim.

Every deletion path in the product assumes single ownership and unlinks the
file outright: `delete_quiz`, and both the replace and delete image routes. So
deleting or replacing an image, or deleting either quiz, physically removed the
shared asset and broke the other quiz. Rows were decoupled; bytes were not.

Crucially the duplicate was NOT broken at the moment of duplication - both
images returned 200 immediately after. The failure only appeared on the first
destructive operation on either side, which is why it looked like duplication
"worked" and then mysteriously did not.

### The fix

Every duplicated quiz now receives its OWN independent image object, via a new
`FileStorage.copy_image` (local copies bytes; S3/R2 uses `copy_object`
server-side). Bytes are copied, never re-encoded, so quality does not degrade
on each duplicate.

Duplication now also preserves three things it was silently dropping:

- `answer_explanation` - the teaching material, lost from every duplicate ever
  made, with no error
- `canvas_width` - the coordinate space annotations were authored against.
  NULL means "assume the legacy 900px canvas", so shapes were copied faithfully
  and then drawn in the WRONG PLACES
- `annotations` alongside it (these two only mean anything together)

Failure behaviour is explicit: a storage failure rolls back, deletes anything
already copied, and returns `502 image_copy_failed` rather than handing over a
duplicate missing pictures. A DB failure after copying rolls back FIRST, then
removes the copied objects, so no attempt leaks a file.

### Production proof (real R2)

Original key `a900d32c04164011833a4f5a179f3532.jpg`, duplicate key
`217dc7b94a81448a9a2b103b35f38846.jpg` - **different objects**. Both returned
HTTP 200 at 84,019 bytes with **identical SHA-256**
(`7abe0666ede15a72...`), proving a byte-for-byte copy rather than a re-encode.

The duplicate quiz was then deleted through the normal coach UI. Afterwards:

- duplicate asset -> **HTTP 404** (it owned its own object, correctly removed)
- original asset -> **HTTP 200, 84,019 bytes, unchanged**

Under the old code that same delete is what destroyed the original. No R2
permission problem, no copy problem, no cleanup problem, no orphaned asset.

### Test coverage

Backend 1299 passed / 3 skipped, including 18 new tests in
`tests/test_quiz_duplication.py`. **13 of those 18 fail when the defects are
deliberately reintroduced.** Coverage includes all six independence cases
(replace/delete an image on either side, delete either quiz), both failure
paths (storage-copy failure, DB failure cleanup), and a fidelity guard that
iterates `Question.__table__.columns` so the NEXT authored field cannot be
silently forgotten the way `answer_explanation` was.

### Why this is conclusively closed

There is no remaining verification gap. The bounded one that existed - real R2
`copy_object` - was closed by the production check above.

---

<details>
<summary>Original report, kept for context</summary>


### What happened

A coach could not edit a question on an active quiz (see Priority 2), so they
used the obvious recovery path:

1. Duplicate the quiz
2. Correct the bad question in the duplicate
3. Activate the duplicate
4. Send the new test

**The images did not appear on the duplicated test.** That defeats the purpose
of Duplicate Quiz: a duplicate that is not a complete copy is a trap, because
the coach only discovers what is missing after the room already has the code.

Note where it failed: **on the test that was sent**, not necessarily inside the
editor. The player delivery path has to be part of the investigation, not just
the duplication function.

### Trace the whole path before changing anything

    ORIGINAL QUIZ
      -> DUPLICATE QUIZ
      -> QUESTIONS COPIED
      -> QUESTION IMAGE ROWS
      -> STORAGE OBJECTS / FILE REFERENCES
      -> IMAGE URLS
      -> PLAYER PAYLOAD
      -> PLAYER RENDERING

Candidate causes, none yet confirmed:

- `question_images` rows not copied at all
- copied questions pointing at the original's image row
- storage objects not copied while rows are
- image URLs generated wrongly for the copy
- organization / quiz / question ownership mismatch on the copy
- image metadata (`canvas_width`) or annotations not copied
- a signed-media or private-URL issue on the player path
- serialisation or player-payload issue rather than a data issue

### The architectural question to answer first

**Do not assume the storage object must be physically duplicated.**

Determine how question images are actually stored and referenced today, then
decide which of these is true:

- If the underlying asset is immutable and shared safely, the duplicate can
  reference the same object, and the fix is about rows and URLs, not bytes.
- If replacing or deleting an image on one quiz could affect the other, the
  duplicate needs independent ownership and a real copy.

That decision drives the fix. Making it backwards - copying bytes because it
feels safer - would double storage for every duplicate forever.

Relevant background: storage keys are opaque (`secrets.token_hex(32)`) with no
organization or quiz prefix, so a key alone does not tell you who owns it.

### Audit what else Duplicate Quiz copies

While in there, establish whether duplication faithfully reproduces:

quiz settings · question order · question types · question text · answer
choices · correct answers · explanations · question images · Draw Response
configuration · image annotations and regions · `allow_drawing` ·
`require_all_answers` · any other question-level configuration.

It must **not** copy: access codes, attempts, responses, results, player
answers, or any other historical or session data.

This is an audit of fidelity, not an invitation to extend the feature.

### Reproduce the failure before believing any diagnosis

Reading the duplication function and concluding it "looks correct" is not an
investigation. Build a quiz locally containing at minimum:

- a question with no image
- a question with a PNG
- a question with a JPEG/WebP, if supported
- a question with an explanation
- a question with drawing enabled
- any annotation or region case that should legally be duplicated

Then duplicate it, open the duplicate as a coach, **activate the duplicate,
join through the real player flow**, and confirm every expected image renders
there. The player flow is where it failed.

### Regression coverage once the cause is proven

- original image question -> duplicate -> activate -> player payload -> image
  renders
- deleting the duplicate does not damage the original
- editing or replacing the duplicate's image does not alter the original
- deleting or replacing the original does not break the duplicate
- organization isolation holds across duplication
- duplication copies no attempts, responses or access codes
- Draw Response and image settings survive where appropriate

The exact shape of these follows the storage architecture, which is why the
architecture question comes first.

---

</details>
