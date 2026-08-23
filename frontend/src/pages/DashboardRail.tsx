import { Link } from 'react-router-dom';
import { Icon } from '../components/ui/Icon';
import type { ActiveQuizStatus, Quiz } from '../api/types';
import { MAX_RESULTS, outstandingPlayers, readyToSend, recentActivity } from './dashboardRailData';
import { responseSummary } from '../utils/responseSummary';
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

  /* Built and never sent. Unlike every panel above it this asks nothing of the
     live poll, which is what lets the rail keep working on a quiet day. */
  const unsent = readyToSend(quizzes ?? []);

  /* THE RAIL IS NOT A LIVE BOARD ANY MORE, and this is a deliberate reversal.

     It used to `return null` whenever nothing was live, on the reasoning that
     a second column of results would be clutter on a quiet day. In practice
     that made the quiet day - the ordinary one - the day the dashboard had the
     least to say: one sentence and a list of quiz titles. The owner's call
     after seeing it: a quiet day should still look intentional and useful, not
     collapse into a mostly empty screen.

     So the rail now CHANGES SUBJECT rather than disappearing. Live now,
     Activity and Closing soon are still gated on live data and simply are not
     rendered when there is none - they could only show zeros. Results and
     Ready to send come from the quiz list, so they survive the quiet day and
     answer the two questions a coach actually arrives with: how did the last
     one go, and what is ready to go out next.

     The empty-handed case still returns null. A rail with nothing true to say
     is worse than no rail, and the layout follows it automatically - the grid
     switches on `:has(> aside)`, so the page widens in the same breath. */
  const hasAnything =
    activity.length > 0 ||
    outstanding > 0 ||
    scored.length > 0 ||
    closing.length > 0 ||
    unsent.length > 0;
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
                  {/* "18 of 24" while a code is live, "17 answered" once it
                      has expired and the denominator with it - never "of 0".
                      See utils/responseSummary. */}
                  {responseSummary(quiz.completed_count, quiz.roster_size) && (
                    <span>{responseSummary(quiz.completed_count, quiz.roster_size)}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unsent.length > 0 && (
        <section className={styles.panel}>
          <h2 className={styles.panelTitle}>Ready to send</h2>
          <p className={styles.panelNote}>Built, with questions, never sent.</p>
          <ul className={styles.unsentList}>
            {unsent.map((quiz) => (
              <li key={quiz.id} className={styles.unsentRow}>
                <Link to={`/quizzes/${quiz.id}?tab=activate`} className={styles.unsentName}>
                  {quiz.title}
                </Link>
                <span className={styles.unsentMeta}>
                  {quiz.question_count} {quiz.question_count === 1 ? 'question' : 'questions'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

/** The quiet day, in one sentence - and now ONLY the sentence.
 *
 * It used to carry the last result too ("Protection IDs scored 97% from 17 of
 * 0"), written back when the rail vanished on a quiet day and this line was
 * the only thing left to say it. The rail no longer vanishes: Results sits
 * beside this note carrying the same quizzes with more room and a link each.
 * Repeating the score here made the page state it twice, and because it
 * rendered the raw counts it was also the loudest place the "of 0" bug showed.
 *
 * So this states the fact the rail cannot - that nothing is out RIGHT NOW,
 * which is live state, not history - and lets Results own the numbers.
 *
 * ONLY WHEN WE ACTUALLY KNOW. `entries` is null until the first poll succeeds,
 * and null is not "nothing is live" - it is "we have not been told". Claiming
 * a quiet day on a failed request would be the one lie this panel could tell.
 */
export function DashboardQuietNote({
  entries,
}: {
  entries: ActiveQuizStatus[] | null;
}) {
  if (entries === null || entries.length > 0) return null;

  return <p className={styles.quietNote}>Nothing is out with players right now.</p>;
}
