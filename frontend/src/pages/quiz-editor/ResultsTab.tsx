import { useCallback, useEffect, useState } from 'react';
import { exportResultsCsv, exportResultsPdf, getQuizDashboard, listResponses } from '../../api/grading';
import { getErrorMessage } from '../../api/client';
import type { PlayerResponse, Quiz, QuizDashboard } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { downloadBlob } from '../../utils/download';
import { ResponseRow } from './ResponseRow';
import nb from '../../styles/notebook.module.css';
import styles from './ResultsTab.module.css';

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'quiz';
}

export function ResultsTab({ quiz }: { quiz: Quiz }) {
  const [dashboard, setDashboard] = useState<QuizDashboard | null>(null);
  const [responses, setResponses] = useState<PlayerResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);

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

  const handleExport = useCallback(
    async (format: 'csv' | 'pdf') => {
      setExporting(format);
      try {
        const blob = format === 'csv' ? await exportResultsCsv(quiz.id) : await exportResultsPdf(quiz.id);
        downloadBlob(blob, `${slugify(quiz.title)}-results.${format}`);
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setExporting(null);
      }
    },
    [quiz.id, quiz.title],
  );

  return (
    <div>
      <ErrorBanner message={error} />

      {dashboard && (
        <>
          <div className={styles.statsRow}>
            <div className={`${nb.card} ${styles.stat}`}>
              <div className={styles.statValue}>{dashboard.response_count}</div>
              <div className={styles.statLabel}>Responses</div>
            </div>
            <div className={`${nb.card} ${styles.stat}`}>
              <div className={styles.statValue}>{dashboard.roster_size}</div>
              <div className={styles.statLabel}>Roster size</div>
            </div>
            <div className={`${nb.card} ${styles.stat}`}>
              <div className={styles.statValue}>{Math.round(dashboard.response_rate * 100)}%</div>
              <div className={styles.statLabel}>Response rate</div>
            </div>
          </div>

          <div className={styles.exportRow}>
            <button
              type="button"
              className={nb.btnSm}
              onClick={() => handleExport('csv')}
              disabled={exporting !== null}
            >
              {exporting === 'csv' ? 'Exporting…' : 'Export CSV'}
            </button>
            <button
              type="button"
              className={nb.btnSm}
              onClick={() => handleExport('pdf')}
              disabled={exporting !== null}
            >
              {exporting === 'pdf' ? 'Exporting…' : 'Export PDF'}
            </button>
          </div>

          {dashboard.question_breakdown.length > 0 && (
            <div className={`${nb.card} ${styles.breakdownCard}`}>
              <h3 className={nb.subheading}>Per-question breakdown</h3>
              <table className={nb.table}>
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

      <h3 className={nb.subheading}>Player responses</h3>
      {responses === null ? (
        <p>Loading…</p>
      ) : responses.length === 0 ? (
        <div className={nb.card}>No responses yet.</div>
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
