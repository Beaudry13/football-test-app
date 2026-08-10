import type { PracticeFeedback } from '../../api/types';

export interface PracticeSummary {
  /** Questions Peira could actually score. */
  scored: number;
  correct: number;
  /** Questions the coach will review by hand - Short Answer, Draw Response. */
  awaitingCoach: number;
  /** Null when nothing was auto-gradable. See the note below. */
  percent: number | null;
}

/** Turns a practice run's feedback into the numbers shown at the end.
 *
 * WHY `percent` CAN BE NULL. A practice quiz made entirely of Short Answer or
 * Draw Response questions has nothing Peira scored, and reporting "0%" there
 * would tell a player they got everything wrong when in truth nothing was
 * marked at all. This is the same rule the coach-facing analytics follow -
 * score is correct / (correct + incorrect), never fabricated from an empty
 * denominator - and it is written out here rather than left to the caller so
 * the player app cannot drift from it. See CLAUDE.md's grading vocabulary.
 *
 * A pure function so it can be tested without rendering anything.
 */
export function summarisePractice(feedback: PracticeFeedback[]): PracticeSummary {
  const scorable = feedback.filter((f) => f.auto_gradable);
  const correct = scorable.filter((f) => f.is_correct === true).length;

  return {
    scored: scorable.length,
    correct,
    awaitingCoach: feedback.length - scorable.length,
    percent: scorable.length > 0 ? Math.round((100 * correct) / scorable.length) : null,
  };
}
