import { useCallback, useEffect, useState } from 'react';
import { getQuizDashboard, listResponses } from '../../api/grading';
import { getErrorMessage } from '../../api/client';
import type { PlayerResponse, Quiz, QuizDashboard } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { ResponseRow } from './ResponseRow';
import styles from './ResultsTab.module.css';

export function ResultsTab({ quiz }: { quiz: Quiz }) {
  const [dashboard, setDashboard] = useState<QuizDashboard | null>(null);
  const [responses, setResponses] = useState<PlayerResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [dashboardData, responseData] = await Promise.all([
        getQuizDashboard(quiz.id),
        listResponses(quiz.id),
      ]);
      setDashboard(dashboardData);
      setResponses(responseData);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [quiz.id]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <ErrorBanner message={error} />

      {dashboard && (
        <>
          <div className={styles.statsRow}>
            <div className="card stat">
              <div className={styles.statValue}>{dashboard.response_count}</div>
              <div className={styles.statLabel}>Responses</div>
            </div>
            <div className="card stat">
              <div className={styles.statValue}>{dashboard.roster_size}</div>
              <div className={styles.statLabel}>Roster size</div>
            </div>
            <div className="card stat">
              <div className={styles.statValue}>{Math.round(dashboard.response_rate * 100)}%</div>
              <div className={styles.statLabel}>Response rate</div>
            </div>
          </div>

          {dashboard.question_breakdown.length > 0 && (
            <div className="card" style={{ marginBottom: '1.5em' }}>
              <h3>Per-question breakdown</h3>
              <table className={styles.breakdownTable}>
                <thead>
                  <tr>
                    <th>Question</th>
                    <th>Correct</th>
                    <th>Incorrect</th>
                    <th>Ungraded</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.question_breakdown.map((q) => (
                    <tr key={q.question_id}>
                      <td>{q.question_text}</td>
                      <td>{q.correct_count}</td>
                      <td>{q.incorrect_count}</td>
                      <td>{q.ungraded_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <h3>Player responses</h3>
      {responses === null ? (
        <p>Loading…</p>
      ) : responses.length === 0 ? (
        <div className="card">No responses yet.</div>
      ) : (
        <div className={styles.responseList}>
          {responses.map((response) => (
            <ResponseRow key={response.id} quiz={quiz} response={response} onGraded={load} />
          ))}
        </div>
      )}
    </div>
  );
}
