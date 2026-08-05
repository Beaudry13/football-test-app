import { useCallback, useEffect, useState } from 'react';
import {
  exportResultsCsv,
  exportResultsDetailedPdf,
  exportResultsPdf,
  getQuizDashboard,
  listResponses,
} from '../../api/grading';
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

type ExportFormat = 'detailed-pdf' | 'summary-pdf' | 'csv';

export function ResultsTab({ quiz }: { quiz: Quiz }) {
  const [dashboard, setDashboard] = useState<QuizDashboard | null>(null);
  const [responses, setResponses] = useState<PlayerResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

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
    async (format: ExportFormat) => {
      setExporting(format);
      try {
        let blob: Blob;
        let suffix: string;
        if (format === 'csv') {
          blob = await exportResultsCsv(quiz.id);
          suffix = 'results.csv';
        } else if (format === 'summary-pdf') {
          blob = await exportResultsPdf(quiz.id);
          suffix = 'summary-results.pdf';
        } else {
          blob = await exportResultsDetailedPdf(quiz.id);
          suffix = 'detailed-results.pdf';
        }
        downloadBlob(blob, `${slugify(quiz.title)}-${suffix}`);
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
            <span className={styles.exportLabel}>Export Results:</span>
            <button
              type="button"
              className={nb.btnPrimary}
              onClick={() => handleExport('detailed-pdf')}
              disabled={exporting !== null}
              title="Every submitted Player, every question, every answer, and grading state - grouped by Player."
            >
              {exporting === 'detailed-pdf' ? 'Exporting…' : 'Detailed PDF'}
            </button>
            <button
              type="button"
              className={nb.btnSm}
              onClick={() => handleExport('summary-pdf')}
              disabled={exporting !== null}
              title="One row per Player - score and grading status only, no per-question detail."
            >
              {exporting === 'summary-pdf' ? 'Exporting…' : 'Summary PDF'}
            </button>
            <button
              type="button"
              className={nb.btnSm}
              onClick={() => handleExport('csv')}
              disabled={exporting !== null}
            >
              {exporting === 'csv' ? 'Exporting…' : 'CSV'}
            </button>
          </div>

          {dashboard.missing_players.length > 0 && (
            <div className={`${nb.card} ${styles.missingCard}`}>
              <h3 className={nb.subheading}>
                Haven't submitted yet ({dashboard.missing_players.length})
              </h3>
              <div className={styles.missingList}>
                {dashboard.missing_players.map((name) => (
                  <span key={name} className={`${nb.badge} ${nb.badgeWarning}`}>
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}

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
        <div className={`${nb.card} ${nb.empty}`}>
          No responses yet. Share the access code to start collecting them.
        </div>
      ) : (
        <div className={styles.responseList}>
          {responses.map((response) => (
            <ResponseRow key={response.id} quiz={quiz} response={response} onChanged={load} />
          ))}
        </div>
      )}
    </div>
  );
}
