import type { ActiveQuizStatus, Quiz } from '../api/types';

/** What the dashboard rail is allowed to say, as plain functions.
 *
 * Its own module for the same reason menuPosition.ts is: a file that exports
 * both components and helpers breaks React's fast-refresh boundary, and these
 * are the parts worth testing directly anyway - what counts as owed, what
 * counts as activity, and how much of either fits in a glance.
 */

export interface ActivityRow {
  key: string;
  at: number;
  time: string;
  who: string;
  quiz: string;
}

/** How many rows each panel is allowed. A rail is a glance, not a log. */
export const MAX_ACTIVITY = 6;
export const MAX_RESULTS = 3;
export const MAX_UNSENT = 3;

/** Most recent submissions across every live code, newest first.
 *
 * Built from the SAME poll the live board uses - `submitted[]` already carries
 * a player name and an ISO `submitted_at` per attempt. Nothing new is fetched
 * and nothing is computed that the server did not say.
 *
 * ONLY LIVE CODES. An expired code is not in the payload at all, so this feed
 * is honestly "what is happening right now", never "recent history". Making it
 * span finished quizzes needs a backend endpoint that does not exist.
 */
export function recentActivity(entries: ActiveQuizStatus[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const entry of entries) {
    for (const attempt of entry.submitted) {
      if (!attempt.submitted_at) continue;
      const at = new Date(attempt.submitted_at).getTime();
      if (Number.isNaN(at)) continue;
      rows.push({
        key: `${entry.access_code_id}:${attempt.player_name}:${attempt.submitted_at}`,
        at,
        time: new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
        who: attempt.player_name,
        quiz: entry.quiz_title,
      });
    }
  }
  return rows.sort((a, b) => b.at - a.at).slice(0, MAX_ACTIVITY);
}

/** How many players a live GRADED code is still waiting on.
 *
 * Practice codes are excluded on purpose. "Six players haven't submitted" is a
 * duty; on a practice code it is not - nobody owes a practice rep, and putting
 * it under "Needs attention" would invent an obligation the product does not
 * have. Same reasoning ActiveQuizStatus already uses when it relabels its own
 * counts for practice.
 */
export function outstandingPlayers(entries: ActiveQuizStatus[]): number {
  return entries
    .filter((e) => !e.is_practice)
    .reduce((total, e) => total + e.not_started.length, 0);
}

/** Quizzes that are built and have never gone out.
 *
 * The one panel here that is about a quiet day rather than a live one, and the
 * reason the rail can now say something useful when nothing is out with
 * players: "what is ready to go" is exactly the question a coach opens Peira
 * with on a Wednesday.
 *
 * EVERY TEST IS AGAINST AN EXPLICIT VALUE, never a falsy check, because both
 * `is_active` and `completed_count` are OPTIONAL on the Quiz type - computed
 * only by list_quizzes, and omitted (not false, not 0) on every other
 * response. `!quiz.is_active` would read "we were not told" as "not active"
 * and put quizzes in this panel that may well be live.
 *
 * `completed_count === 0` rather than "never activated": the product has no
 * has-been-sent flag, and a quiz that went out and nobody answered is not
 * ready to send - it has already been sent. Zero completions with no live code
 * is the closest true statement the data supports.
 *
 * `question_count > 0` because an empty quiz cannot be activated at all, so
 * offering it as ready would be a dead end.
 */
export function readyToSend(quizzes: Quiz[]): Quiz[] {
  return quizzes
    .filter(
      (q) => q.is_active === false && q.completed_count === 0 && q.question_count > 0,
    )
    .slice(0, MAX_UNSENT);
}
