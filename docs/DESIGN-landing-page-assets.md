# Landing page — the 30-second story, and what it is made of

Not built. This is the asset plan: which real Peira surfaces tell the story,
what football content to put in them, and what has to exist first.

**Constraint, stated once and applying to all of it: no invented testimonials,
usage statistics, logos, or customers.** Peira is in Early Access. The honest
story is *what the product does*, shown with real football, not *who uses it*.

## The through-line

The four beats are one continuous artefact, not four screenshots of four
features: **one play** — a Cover 3 install page — followed from the playbook a
coach already owns to the answer a player gives to the number the coach reads
on the sideline. If the same play appears in all three beats, the story tells
itself. If each beat uses a different play, it becomes a feature tour.

Recommended play: **Cover 3 — who has the flat?** It is legible to a
non-coach, has one right answer, and is a genuine install-week question.

---

## 0–10s · PLAYBOOK → QUESTION

**What it shows:** a real playbook page, a region drawn on it, and the
question that came out of it.

- **Source surface** `pages/documents/DocumentPage.tsx` + `RegionDraw.tsx`
  (route `/documents/:documentId`), then `QuestionEditor` showing the created
  question.
- **Football content** page 12 of a "2026 Base Defense Install" — a Cover 3
  diagram. Region drawn around the flat zone. Resulting question: *"Cover 3 —
  who has the flat?"* with options Strong safety / Corner / Outside
  linebacker / Nickel.
- **Data needed** one PDF playbook with a genuine coverage diagram, one
  `question_region`, one multiple-choice question. **This is the only beat
  that needs an asset Peira cannot generate: a real playbook page.**
- **Form** *Recreated UI composition.* The real screen has chrome the story
  does not need, and the playbook page is the one thing that must be
  purpose-drawn rather than borrowed.
- **Anonymise** the diagram must be drawn for this purpose, not lifted from a
  real program's playbook. No school name, crest, colours, or coach name.
- **Desktop** side by side — page left, question right — so the causation is
  spatial and needs no caption.
- **Mobile** stacked, page above question, with the region highlight the
  visual link.

## 10–20s · PLAYER ANSWERS

**What it shows:** the same question on a phone, answered by a player.

- **Source surface** `pages/play/PlayPage.tsx` — **the real player UI, already
  light and already the most phone-ready surface in the product.**
- **Football content** the same Cover 3 question; the player taps "Strong
  safety". For a stronger second frame, use a **draw-response** question —
  *"Draw your run fit"* — because drawing on a film still is the thing no
  quiz tool does, and it is already built (`DrawingBoard`).
- **Data needed** an active practice access code, a roster with plausible
  names, one submitted answer, optionally one saved drawing document.
- **Form** *Live product component* — genuinely the strongest option here. The
  player UI needs no restyling to look good on a landing page, which is worth
  saying out loud: this beat can be a real embedded component rather than an
  image.
- **Anonymise** invented player names and numbers. No real roster, ever.
- **Desktop** a phone frame, at real device width, beside the play.
- **Mobile** full-bleed — on a phone the player UI *is* the mobile
  presentation, so show it at 1:1 rather than inside a frame.

## 20–30s · COACH SEES RESULTS

**What it shows:** the number that makes the point — which players know it and
which do not.

- **Source surface** `ResultsTab` (in-editor) for the roster view, or the
  per-question breakdown for the sharper story.
- **Football content** *18 of 24 correct.* The six who missed it named. The
  strongest single frame is **the per-question line**: "Cover 3 — who has the
  flat? · 75%", because it shows the product answering *"what do we need to
  re-install on Tuesday?"* rather than *"who is smart?"*.
- **Data needed** ~24 attempts with a realistic spread. **A local seed already
  produces exactly this** (`ZZ Scale Audit FC`), so the shape can be checked
  before any design work.
- **Form** *Recreated UI composition.* The real Results tab currently shows
  exports before results (audit P1-8) and carries the full editor chrome. Do
  not ship a screenshot of a screen with a known information-order problem —
  either fix that first or compose the frame.
- **Anonymise** invented player names. **No real scores, no real program.**
- **Desktop** the per-question bar with the roster beside it.
- **Mobile** per-question result alone; the roster becomes a "6 players missed
  this" line.

## Optional 4th · SHARE PEIRA

**What it shows:** how a Peira reaches players — a code, a link, a QR.

- **Source surface** `pages/quiz-editor/SharePeira.tsx` — Copy link, Show QR
  code, and the "Available until" sentence.
- **Football content** code, and *"Available until Saturday at 9:00 AM"* —
  that sentence is one of the clearest things in the product and is worth
  showing verbatim.
- **Data needed** one activated code. **Use a fake code in the artwork** — a
  real one on a public page is an open door to a real quiz.
- **Form** *Recreated UI composition*, for that reason alone.
- **Desktop** small, as a closing beat, not a fourth equal panel.
- **Mobile** the QR at scannable size or omitted — a QR you cannot scan from
  the device displaying it is decoration.

---

## What must exist before design starts

1. **A purpose-drawn playbook page** with a Cover 3 diagram. The only asset
   that cannot come from the product. Everything else Peira can generate.
2. **A demo organization with the story's data** — one playbook, one quiz with
   the Cover 3 question, ~24 attempts. The audit seed is already 90% of this.
3. **A decision on live-vs-image per beat.** The recommendation above is
   *live* for the player beat, *composed* for the other three — because those
   three each carry either chrome the story does not need or a known layout
   problem.

## What to avoid

- Feature grids. The four beats are a sequence; a grid destroys the causation
  that makes them work.
- Screenshots of screens with known 375px defects — the audit lists them.
- Implying scale. "Programs using Peira", counters, logo walls: none of it is
  true yet, and the product does not need it to be interesting.
- A dark landing page paired with a light product. The coach theme is going
  light; the landing page should land there too.
