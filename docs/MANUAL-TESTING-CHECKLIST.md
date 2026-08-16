# Manual testing checklist

Things that have shipped to production but have **not** been exercised by a
human on the real site.

## Why this file exists

Development used to stop after every phase for a hands-on production
walkthrough. That is now deliberately deferred: automated tests, gates,
browser automation and deployment probes carry the routine verification, and
this file records what genuinely still wants a person.

**The rule that makes this safe:** nothing here may be described as
"production verified". Accurate labels are:

| Label | Means |
|---|---|
| automated verified | covered by the test suites |
| dev/browser verified | driven in a browser against a dev server |
| deployed and health verified | deploy succeeded, health/bundle probed live |
| manual production verification deferred | **listed here, awaiting a person** |

Work through this in a batched hands-on session rather than item by item.
Tick items off by deleting them and noting the date in the git commit.

---

## PHASE 4A / ATTEMPT VERSION INVARIANT

**Status: MANUAL PRODUCTION VERIFICATION DEFERRED**
Shipped in `94b63c2` (16 Aug 2026). Deployed and health verified.

The invariant: *once an attempt starts, it stays on the version it was
delivered.* Corrections reach a player only on a NEW attempt.

Use an existing safe test/dev quiz. **Text edits only** - do not change the
correct answer, question type, region geometry, scoring or exclusions, as
those are all still blocked after delivery by design.

- [ ] Start an attempt on version A; confirm it opens normally
- [ ] Answer at least two questions (needed for the saved-answer check below)
- [ ] Note Q1's exact wording and the question numbering
- [ ] While that attempt is still open, correct one question's TEXT to version B
- [ ] Refresh / rejoin the EXISTING attempt
- [ ] Confirm it still shows **version A** text
- [ ] Confirm the saved answers survived
- [ ] Confirm question order and Q# are unchanged
- [ ] Start a NEW attempt (different roster player)
- [ ] Confirm the new attempt shows **version B** text
- [ ] Confirm the old attempt can still be submitted

**Decisive result:** OLD ATTEMPT → OLD VERSION, NEW ATTEMPT → NEW VERSION.

**Failure signals - stop and report rather than patching:** the existing
attempt shows the new text; the new attempt shows the old text; resume
breaks; the player cannot submit; `/play/start` 500s.

### Already covered automatically - do NOT re-test by hand

- Both directions of the invariant (text, options, image) - `test_attempt_version_invariant.py`
- `/play/start` exposes no `is_correct_answer` / `expected_answers` - raw response body is grepped in the same file
- Saved answers survive resume and resolve to their delivered option
- `require_all_answers` validates the delivered set
- Legacy attempts (no snapshot) still play
- Historical Results / CSV / PDF read delivered content
- Query counts stay flat as quiz length grows

### Known bounded gap

`QuestionEditor.test.tsx` did not run in the last `npm run test:ci` (the
documented collection flake - see CLAUDE.md). It passes standalone and
nothing in `94b63c2` touches it or its imports, but that file was not part
of the green run that shipped this commit.
