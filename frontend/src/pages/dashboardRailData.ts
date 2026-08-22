import type { ActiveQuizStatus } from '../api/types';

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
