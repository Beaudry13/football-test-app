# Known issues — queued work, reported from real use

This file is **not** the Improvement Bank. Everything in that file was
considered and deliberately deferred. Everything here is a real problem a coach
hit in real use, is approved to be worked on, and is waiting only on sequencing.

**Sequencing: both are queued behind the current Competition Mode milestone.**
Do not interrupt Competition work to start them — bouncing between features is
how regressions get made. When Competition M2 is frozen, take them in the order
below.

Neither has been investigated yet. Nothing in the "what to check" sections is a
conclusion; they are the questions to answer *before* proposing a fix.

---

## PRIORITY 1 — Duplicating a quiz loses its images

**Status: reported, unreproduced, uninvestigated. Appears to be objectively
broken behaviour rather than a design limitation.**

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

## PRIORITY 2 — A coach cannot correct a question on an active quiz

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
approval before implementing the override.** The duplicate-image fix may
proceed as an ordinary bug fix once its root cause is proven.
