import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getPlayerHistory } from '../api/grading';
import { getErrorMessage } from '../api/client';
import type { PlayerHistoryEntry } from '../api/types';
import { ErrorBanner } from '../components/ErrorBanner';
import nb from '../styles/notebook.module.css';
import styles from './PlayerHistoryPage.module.css';
import { LoadingState } from '../components/ui/LoadingState';
import { EmptyState } from '../components/ui/EmptyState';
import { Icon } from '../components/ui/Icon';

export function PlayerHistoryPage() {
  const { playerName: encodedName } = useParams<{ playerName: string }>();
  const playerName = encodedName ? decodeURIComponent(encodedName) : '';
  const [history, setHistory] = useState<PlayerHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!playerName) return;
    setHistory(null);
    setError(null);
    getPlayerHistory(playerName)
      .then((data) => setHistory(data.history))
      .catch((err) => setError(getErrorMessage(err)));
  }, [playerName]);

  const totalGraded = history?.reduce((sum, h) => sum + h.graded_answer_count, 0) ?? 0;
  const totalCorrect = history?.reduce((sum, h) => sum + h.correct_answer_count, 0) ?? 0;
  const totalPending = history?.reduce((sum, h) => sum + h.pending_grading_count, 0) ?? 0;
  const accuracy = totalGraded > 0 ? Math.round((totalCorrect / totalGraded) * 100) : null;

  return (
    <div>
      <Link to="/dashboard" className={styles.backLink}>
        <Icon name="back" size={14} /> All Quizzes
      </Link>

      <h1 className={nb.heading}>{playerName}</h1>
      <p className={styles.subheading}>Quiz history matched by player name</p>

      {/* Named history, not canonical history. These results are found by
          matching the name on the attempt, so Peira does NOT know they
          belong to the player of that name on the Master Roster - two people
          can share a name. The wording therefore says "may not appear" and
          never claims the records are theirs. The authoritative surface is
          the Player Profile, reached from the Roster. */}
      <div className={`${nb.card} ${styles.legacyNotice}`}>
        <h2 className={nb.subheading}>Legacy quiz history</h2>
        <p>
          These results came from older quiz rosters that were saved by player name instead of
          being linked to the Master Roster. They may not appear in the player&rsquo;s main
          profile.
        </p>
        <p>
          For a player&rsquo;s full, up-to-date record, open them from your{' '}
          <Link to="/roster">Roster</Link>.
        </p>
      </div>

      <ErrorBanner message={error} />

      {history === null ? (
        <LoadingState />
      ) : history.length === 0 ? (
        <EmptyState message="No Quiz history found for this name yet. Names must match exactly, including spelling and spacing." />
      ) : (
        <>
          <div className={nb.card} style={{ marginBottom: '1.5em' }}>
            <h2 className={nb.subheading}>
              {history.length} Quiz{history.length === 1 ? '' : 'zes'} taken
              {accuracy !== null && <> · {accuracy}% correct overall</>}
              {totalPending > 0 && (
                <>
                  {' '}
                  <span className={`${nb.badge} ${nb.badgeWarning}`}>
                    {totalPending} answer{totalPending === 1 ? '' : 's'} pending grading
                  </span>
                </>
              )}
            </h2>
            {totalPending > 0 && (
              <p className={styles.pendingNote}>
                The overall average above doesn't include these yet - it'll shift once they're graded.
              </p>
            )}
          </div>

          <table className={nb.table}>
            <thead>
              <tr>
                <th>Quiz</th>
                <th>Submitted</th>
                <th>Graded correct</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.response_id}>
                  <td>
                    <Link to={`/quizzes/${entry.quiz_id}?tab=results`}>{entry.quiz_title}</Link>
                  </td>
                  <td>{new Date(entry.submitted_at).toLocaleDateString()}</td>
                  <td className={styles.correctCell}>
                    {entry.graded_answer_count > 0
                      ? `${entry.correct_answer_count} / ${entry.graded_answer_count}`
                      : '—'}
                    {entry.pending_grading_count > 0 && (
                      <span className={`${nb.badge} ${nb.badgeWarning} ${styles.pendingBadge}`}>
                        {entry.pending_grading_count} to grade
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
