/** How many players answered, said truthfully when there is no denominator.
 *
 * THE BUG THIS EXISTS TO PREVENT: dashboards reading "17 of 0".
 *
 * `completed_count` and `roster_size` are not two halves of one fraction, and
 * the product has never guaranteed that they are:
 *
 *   - `completed_count` is ALL-TIME. Every SUBMITTED graded attempt this quiz
 *     has ever received, across every activation.
 *   - `roster_size` is RIGHT NOW. The players eligible under the quiz's
 *     CURRENTLY ACTIVE access code - group-restricted if that code names
 *     groups, otherwise the quiz's own Roster.
 *
 * So the denominator disappears the moment the code expires. The backend's
 * `effective_roster_names_for_quiz` only receives a code that is still active;
 * with none it falls back to `quiz.roster`, which is legitimately EMPTY for
 * the ordinary modern workflow - a coach who activates against a Group never
 * has to build a per-quiz Roster at all, and groups are linked to the ACCESS
 * CODE, not to the quiz. Seventeen players answer, the code expires a week
 * later, and the eligible set goes to zero while the seventeen stay.
 *
 * That is not bad data. `roster_size` is correct for what it means. It is only
 * wrong to PRINT it as the denominator of a historical count.
 *
 * There is no honest denominator to substitute, either. The eligible set that
 * applied at the time is not recorded anywhere (delivered-question snapshots
 * record questions, not rosters), and a quiz activated twice to two different
 * groups has no single "who was assigned" to recover. Reconstructing one from
 * the attempts themselves is circular - it would always equal the numerator
 * and every quiz would read 100%.
 *
 * So when the denominator is genuinely unavailable this says how many answered
 * and stops, rather than inventing a total.
 *
 * ONE HELPER, THREE SURFACES - the quiz card, the dashboard rail's Results
 * panel and the Results tab all render this. They were three separate
 * expressions and all three printed "of 0"; sharing the rule is what stops the
 * next one from being missed.
 */
export function responseSummary(
  completedCount: number | undefined,
  rosterSize: number | undefined,
): string | null {
  if (completedCount === undefined) return null;

  /* > 0, not `!== undefined`. Zero is exactly the value that must not become a
     denominator, and it is the value the backend actually sends - the key is
     present and set to 0, so an undefined-check would sail straight past it. */
  if (rosterSize !== undefined && rosterSize > 0) {
    return `${completedCount} of ${rosterSize}`;
  }

  if (completedCount > 0) return `${completedCount} answered`;

  /* Nothing answered and nobody eligible. "0 answered" is technically true and
     reads like a failure; this is the same state a brand-new quiz is in. */
  return 'No responses yet';
}

/** Whether a response RATE can honestly be shown.
 *
 * The backend divides an all-time numerator by the same right-now denominator
 * and returns 0.0 when it is zero - so the Results tab could report a 0%
 * response rate for a quiz seventeen players completed. Scores already refuse
 * to do this (`average_score_percent` is omitted, never 0, until something is
 * gradeable); a rate deserves the same treatment.
 */
export function hasResponseDenominator(rosterSize: number | undefined): boolean {
  return rosterSize !== undefined && rosterSize > 0;
}
