import { Link } from 'react-router-dom';
import { Icon } from '../components/ui/Icon';
import type { ActiveQuizStatus, Quiz } from '../api/types';
import { MAX_RESULTS, outstandingPlayers, recentActivity } from './dashboardRailData';
import styles from './DashboardRail.module.css';

export function DashboardRail({
  entries,
  quizzes,
}: {
  entries: ActiveQuizStatus[] | null;
  quizzes: Quiz[] | null;
}) {
  const live = entries ?? [];
  const activity = recentActivity(live);
  const outstanding = outstandingPlayers(live);

  /* Only quizzes that have a score to show. `average_score_percent` is OMITTED
     (never 0) until something gradeable has been answered, so this is the
     product's own answer to "is there a result here yet" rather than a
     threshold invented here. */
  const scored = (quizzes ?? [])
    .filter((q) => q.average_score_percent !== undefined)
    .slice(0, MAX_RESULTS);

  /* Closing times earn a panel only when there is more than one live code.
     With a single one the live card above already says when it closes, and
     repeating it would be a second copy of the same sentence. */
  const closing =
    live.length > 1
      ? [...live].sort(
          (a, b) => new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime(),
        )
      : [];

  /* THE RAIL IS A LIVE BOARD, so it exists only while something is live.
     Results alone would keep a second column on screen on a day when nothing
     is out with players - which is the day the approved design deliberately
     makes the dashboard quieter and gives the quizzes the whole width. What a
     coach loses is one glance at a score, and DashboardQuietNote gives that
     back in a sentence. */
  if (live.length === 0) return null;

  const hasAnything =
    activity.length > 0 || outstanding > 0 || scored.length > 0 || closing.length > 0;
  if (!hasAnything) return null;

  return (
    <aside className={styles.rail} aria-label="At a glance">
      {outstanding > 0 && (
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Needs attention</h2>
          <div className={styles.attention}>
            <Icon name="info" size={18} />
            <div>
              <div className={styles.attentionLine}>
                {outstanding} {outstanding === 1 ? 'player hasn’t' : 'players haven’t'} submitted
              </div>
              <div className={styles.attentionMeta}>
                {live
                  .filter((e) => !e.is_practice && e.not_started.length > 0)
                  .map((e) => e.quiz_title)
                  .join(' · ')}
              </div>
            </div>
          </div>
        </section>
      )}

      {activity.length > 0 && (
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2 className={styles.panelTitle}>Activity</h2>
            <span className={styles.livePip} aria-hidden="true" />
          </div>
          <ul className={styles.feed}>
            {activity.map((row) => (
              <li key={row.key} className={styles.feedRow}>
                <span className={styles.feedTime}>{row.time}</span>
                <span className={styles.feedText}>
                  <strong>{row.who}</strong> submitted {row.quiz}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {closing.length > 0 && (
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Closing soon</h2>
          <ul className={styles.closingList}>
            {closing.map((entry) => (
              <li key={entry.access_code_id} className={styles.closingRow}>
                <Link to={`/quizzes/${entry.quiz_id}?tab=activate`} className={styles.closingName}>
                  {entry.quiz_title}
                </Link>
                <span className={styles.closingWhen}>
                  {new Date(entry.expires_at).toLocaleString(undefined, {
                    weekday: 'short',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {scored.length > 0 && (
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Results</h2>
          <ul className={styles.resultList}>
            {scored.map((quiz) => (
              <li key={quiz.id} className={styles.resultRow}>
                <Link to={`/quizzes/${quiz.id}?tab=results`} className={styles.resultName}>
                  {quiz.title}
                </Link>
                <div className={styles.resultMeta}>
                  <span className={styles.resultScore}>
                    {Math.round(quiz.average_score_percent as number)}%
                  </span>
                  {quiz.completed_count !== undefined && quiz.roster_size !== undefined && (
                    <span>
                      {quiz.completed_count} of {quiz.roster_size}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

/** The quiet day, in one sentence.
 *
 * Rendered instead of the rail when nothing is out with players. It says the
 * thing the missing rail would have said and stops - no panels, no zeros, and
 * the quiz list keeps the full width behind it.
 *
 * ONLY WHEN WE ACTUALLY KNOW. `entries` is null until the first poll succeeds,
 * and null is not "nothing is live" - it is "we have not been told". Claiming
 * a quiet day on a failed request would be the one lie this panel could tell.
 */
export function DashboardQuietNote({
  entries,
  quizzes,
}: {
  entries: ActiveQuizStatus[] | null;
  quizzes: Quiz[] | null;
}) {
  if (entries === null || entries.length > 0) return null;

  const lastScored = (quizzes ?? []).find((q) => q.average_score_percent !== undefined);

  return (
    <p className={styles.quietNote}>
      Nothing is out with players right now.
      {lastScored && (
        <>
          {' '}
          <Link to={`/quizzes/${lastScored.id}?tab=results`} className={styles.quietLink}>
            {lastScored.title}
          </Link>{' '}
          scored {Math.round(lastScored.average_score_percent as number)}%
          {lastScored.completed_count !== undefined &&
            lastScored.roster_size !== undefined &&
            ` from ${lastScored.completed_count} of ${lastScored.roster_size}`}
          .
        </>
      )}
    </p>
  );
}
