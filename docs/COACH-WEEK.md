# The coach's week: find, teach, assign, grade, fix, reteach

This covers the coach-week cycle (22 October 2026), on the local branch
`feature/coach-week`, which is not deployed. The goal was to make the weekly
loop one connected workflow, with less clicking, retyping and hunting. It
builds on `CONNECTED-SYSTEM.md`, which covers create-once and grade-fast.

## Find / create

**Made from this play** sits under Motion Lab's *Use this play*. For each quiz
or Rep made from the play it now shows:
- what the questions are about, in the coach's own words (concepts and "You're
  the...");
- when the Rep's problem was last marked taught.

Example: "3 decisions · Boundary safety · Motion adjustment · taught Oct 21".
It comes from `GET /api/quizzes/made-from-play/<id>` (`concepts`, `roles`,
`taught_at`).

*Teach a moment* records on this device when the play was taught
(`motion-lab/taughtMemory.ts`). The menu then says "You taught it Tue Oct 21".
Teach itself still saves nothing to PEIRA.

## Assign

**The Activate tab says who gets it, before it goes.** It follows the
server's own rule (`services/access_codes`):

| What the coach has picked | What the tab says |
|---|---|
| Positions | "Goes to 4 players." The players join this quiz's list, and the code goes to that list. |
| A saved group on its own | "Goes to the 7 players in Defense - instead of the 3 on this quiz's list." A group on its own replaces the list for that code. |
| Nothing, and the list has players | "Goes to these 3: Ty Adams, Bo Brown and Cam Cole." On a retest, the list is exactly the players who missed it. |
| Nothing, and the list is empty | "Nobody yet - pick positions or a group above, or add players on the Roster tab." Activate stays disabled instead of failing. |

Other assignment changes:
- **A quiz retest opens ready to send.** All three retest entry points
  (concept card, concept row, question row) open the new quiz on its
  Activate tab, which names who gets it, instead of on its questions. The
  coach still sends it.
- **Same as last time.** On a quiz whose list is empty, the tab offers "Same
  as last time: Safeties and Defense".
  - That is the chips and groups from the last quiz this coach sent on this
    device, provided they still exist.
  - One tap applies it, and nothing is applied until he taps.
  - It is remembered only after a send succeeds, and is never offered on a
    retest, because a retest's list is already set.
- **Reactivate keeps the live code's audience** and says so. Groups that were
  ticked earlier no longer carry silently into the next activation.

## Grade

- **Home → Needs attention** says, for example, "7 to grade · Week 6 install",
  one tap from that quiz's grading screen. The data comes from
  `GET /api/quizzes/to-grade`, which uses the grading screen's rules:
  submitted official attempts, written or drawn answers only, and questions
  excluded with "don't count" are left out.
- **All caught up** on one quiz then offers "Next: Red zone · 2 to grade".
  The grading keys and the rest are described in `CONNECTED-SYSTEM.md`.

## See what needs fixing → reteach / retest

**Results.** Every concept row can now be acted on, not only the top card:
- *Retest these N* builds the same concept retest, for exactly the players
  who missed it.
- *Who missed it* is one tap down, under More, with each name opening the
  player's profile.

These links and buttons now go straight to where the work happens:
- A Rep made from a missed question goes to the players who missed it.
- Home's "Retest it" opens with that problem's confirm already up.
- A quiz concept's *Teach* on a player's profile opens that concept's Teach.
- The Rep page's Players table links each player's profile.

A Rep retest that was created but not sent (activation failed) now opens
anyway. That applies on both the Rep page and concept history, so a second
tap can no longer build a second retest.

**Players and positions.** Team → Players filters by position group, using the
families a Rep is sent with: "Safeties (FS, S, SS) · 4". With a group picked,
**What your safeties need** shows:
- the concepts they are still working on, using the profile's own rules
  (`services/player_learning`, now computed for many players in one pass:
  `players_learning`);
- who is still working on each one;
- *Teach*, which opens where the latest of them missed it;
- *Retest the N*, which puts each player's missed decisions into one Rep for
  exactly those players and opens it ready to send.

That panel is fed by `GET /api/players/needs?ids=...`, which:
- only includes players from the coach's own organization;
- shows results the way Coach View does;
- accepts at most 60 players.

## Continue where you left off

Home shows one quiet line under Next up: "Pick up where you left off: Week 6
install · Quiz". It is the quiz or Rep the coach last opened on this device
(`pages/home/lastWork.ts`), stored per coach. It appears only while that quiz
or Rep still exists, and uses its current name.

## Unchanged

- Answer-reveal policies, the practice/graded rules and the retry rules.
- Coach judgment in grading. There is no bulk grading.
- The migration chain. This cycle added no migrations.
