import { useCallback, useEffect, useState } from 'react';
import {
  exportResultsCsv,
  exportResultsDetailedPdf,
  exportResultsPdf,
  getQuizDashboard,
  listResponses,
} from '../../api/grading';
import { getErrorMessage } from '../../api/client';
import type {
  PlayerResponse,
  QuestionBreakdown,
  QuestionExclusion,
  Quiz,
  QuizAssignment,
  QuizDashboard,
} from '../../api/types';
import { listQuizAssignments, restoreQuestionExclusion } from '../../api/questionExclusions';
import { describeExclusionScope } from './assignmentLabel';
import { ExcludeQuestionDialog } from './ExcludeQuestionDialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { downloadBlob } from '../../utils/download';
import { ResponseRow } from './ResponseRow';
import nb from '../../styles/notebook.module.css';
import styles from './ResultsTab.module.css';
import { LoadingState } from '../../components/ui/LoadingState';
import { EmptyState } from '../../components/ui/EmptyState';

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'quiz';
}

type ExportFormat = 'detailed-pdf' | 'summary-pdf' | 'csv';

/** One active exclusion, with its scope and its own Restore.
 *
 * Rendered per exclusion rather than once per question so an overlapping
 * quiz-wide + assignment pair reads as the two separate decisions it is.
 * Restoring one reports what is STILL excluding the question, so the coach is
 * never told it counts again while the other is in force. */
function ExclusionNote({
  quizId,
  questionId,
  exclusion,
  assignments,
  onChanged,
}: {
  quizId: number;
  questionId: number;
  exclusion: QuestionExclusion;
  assignments: Map<number, QuizAssignment>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [stillExcluded, setStillExcluded] = useState<QuestionExclusion[] | null>(null);

  async function handleRestore() {
    setBusy(true);
    try {
      const result = await restoreQuestionExclusion(quizId, questionId, exclusion.id);
      setStillExcluded(result.still_excluded_by);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  // NAMES THE ASSIGNMENT. "one assignment" left a coach on this pooled page
  // unable to tell WHICH delivery had stopped counting - the walkthrough's one
  // real finding. Falls back to the old generic wording if the assignment
  // cannot be resolved, rather than breaking the row.
  const scopeLabel = describeExclusionScope(
    exclusion.scope,
    exclusion.access_code_id,
    assignments,
  );

  return (
    <div className={styles.exclusionNote}>
      <span>
        Not counted for {scopeLabel}
        {exclusion.excluded_by_username ? ` · ${exclusion.excluded_by_username}` : ''}
        {exclusion.reason ? ` · “${exclusion.reason}”` : ''}
      </span>
      <button type="button" className={nb.btnSm} onClick={handleRestore} disabled={busy}>
        {busy ? 'Restoring…' : 'Restore'}
      </button>
      {stillExcluded !== null && stillExcluded.length > 0 && (
        <span className={styles.stillExcluded}>
          Still excluded by another rule covering{' '}
          {stillExcluded.some((e) => e.scope === 'quiz') ? 'all assignments' : 'another assignment'}.
        </span>
      )}
    </div>
  );
}

export function ResultsTab({ quiz }: { quiz: Quiz }) {
  const [dashboard, setDashboard] = useState<QuizDashboard | null>(null);
  const [responses, setResponses] = useState<PlayerResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [excluding, setExcluding] = useState<QuestionBreakdown | null>(null);
  const [assignmentsById, setAssignmentsById] = useState<Map<number, QuizAssignment>>(new Map());

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

    // Loaded SEPARATELY and never fatal. These only name the exclusion chips;
    // failing to fetch them must leave Results working with the generic
    // wording, not blank the page over a label.
    try {
      const assignments = await listQuizAssignments(quiz.id);
      setAssignmentsById(new Map(assignments.map((a) => [a.access_code_id, a])));
    } catch {
      setAssignmentsById(new Map());
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
              <h2 className={nb.subheading}>
                Haven't submitted yet ({dashboard.missing_players.length})
              </h2>
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
              <h2 className={nb.subheading}>Per-question breakdown</h2>
              <table className={nb.table}>
                <thead>
                  <tr>
                    <th>Question</th>
                    <th>Correct</th>
                    <th>Incorrect</th>
                    <th>Ungraded</th>
                    <th aria-label="Scoring" />
                  </tr>
                </thead>
                <tbody>
                  {dashboard.question_breakdown.map((q) => (
                    <tr key={q.question_id} className={q.is_excluded ? styles.excludedRow : undefined}>
                      <td>
                        {q.question_text}
                        {/* Every active exclusion, not a single boolean: a
                            quiz-wide and an assignment-scoped one can overlap,
                            and restoring one leaves the other in force. */}
                        {q.exclusions.map((ex) => (
                          <ExclusionNote
                            key={ex.id}
                            quizId={quiz.id}
                            questionId={q.question_id}
                            exclusion={ex}
                            assignments={assignmentsById}
                            onChanged={load}
                          />
                        ))}
                      </td>
                      {/* RAW COUNTS, never filtered by exclusion - usually the
                          very reason the coach excluded the question. */}
                      <td>{q.correct_count}</td>
                      <td>{q.incorrect_count}</td>
                      <td>{q.ungraded_count}</td>
                      <td className={styles.breakdownAction}>
                        {q.is_excluded ? (
                          <span className={`${nb.badge} ${nb.badgeWarning}`}>Excluded</span>
                        ) : (
                          <button
                            type="button"
                            className={nb.btnSm}
                            onClick={() => setExcluding(q)}
                          >
                            Don&rsquo;t count this
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <h2 className={nb.subheading}>Player responses</h2>
      {responses === null ? (
        <LoadingState />
      ) : responses.length === 0 ? (
        <EmptyState message="No responses yet. Share the access code to start collecting them." />
      ) : (
        <div className={styles.responseList}>
          {responses.map((response) => (
            <ResponseRow key={response.id} quiz={quiz} response={response} onChanged={load} />
          ))}
        </div>
      )}

      {excluding && (
        <ExcludeQuestionDialog
          quizId={quiz.id}
          question={excluding}
          onCancel={() => setExcluding(null)}
          onExcluded={() => {
            setExcluding(null);
            load();
          }}
        />
      )}
    </div>
  );
}
