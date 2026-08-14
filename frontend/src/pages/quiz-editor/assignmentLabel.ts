import type { QuizAssignment } from '../../api/types';

/** How an assignment is named for a coach.
 *
 * A coach thinks "Monday's Defense session", not "access code id 24". Every
 * part of this is metadata Peira already stores - group names, activation
 * date, the code itself - so naming an assignment needed no new schema.
 *
 * Shared by the exclusion dialog and the excluded-row chip ON PURPOSE. The
 * walkthrough found the chip saying only "one assignment", which left a coach
 * unable to tell WHICH of a pooled quiz's deliveries had stopped counting;
 * having one definition means the name they picked from and the name they see
 * afterwards cannot drift apart.
 */

function audience(assignment: QuizAssignment): string {
  // Groups are the strongest signal a coach recognises. No groups means the
  // code went to the quiz's own roster.
  return assignment.groups.length > 0
    ? assignment.groups.map((g) => g.name).join(', ')
    : 'Whole roster';
}

/** The picker's label - fullest form, including how many responses it covers,
 *  because that is what tells a coach how much a choice will change. */
export function describeAssignment(assignment: QuizAssignment): string {
  const when = new Date(assignment.activated_at).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${when} · ${audience(assignment)} · ${assignment.submitted_count} submitted · ${assignment.code}`;
}

/** The chip's label - the same identity, short enough to sit inline on a
 *  table row. Drops the weekday and the submitted count; keeps the code,
 *  which is the tiebreaker when a coach activated twice for one group on one
 *  day. */
export function describeAssignmentBrief(assignment: QuizAssignment): string {
  const when = new Date(assignment.activated_at).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${audience(assignment)} · ${when} (${assignment.code})`;
}

/** What the excluded row says, given the exclusion's scope and whatever
 *  assignment metadata is to hand.
 *
 * FALLS BACK RATHER THAN BREAKING. The assignment may be unresolvable - the
 * access code was deleted, or the assignments request failed - and a Results
 * page that blanks out because it could not name an assignment would be a far
 * worse failure than a vaguer label. The generic wording is exactly what this
 * row said before the label existed, so the fallback is a known-good state.
 */
export function describeExclusionScope(
  scope: 'assignment' | 'quiz',
  accessCodeId: number | null,
  assignments: Map<number, QuizAssignment>,
): string {
  if (scope === 'quiz') return 'all assignments';
  const assignment = accessCodeId === null ? undefined : assignments.get(accessCodeId);
  return assignment ? describeAssignmentBrief(assignment) : 'one assignment';
}
