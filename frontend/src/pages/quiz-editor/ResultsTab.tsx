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
import { RetestVerification } from './RetestVerification';
import { WeakestConcepts } from './WeakestConcepts';
import { hasResponseDenominator } from '../../utils/responseSummary';
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

  // Exclusions come from the dashboard (a live, quiz-level fact). Question
  // NUMBERING for an expanded player does NOT: that has to be the number the
  // player was given, which travels with the response payload itself.
  const exclusionsByQuestion = new Map(
    (dashboard?.question_breakdown ?? [])
      .filter((q) => q.exclusions.length > 0)
      .map((q) => [q.question_id, q.exclusions]),
  );

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

  /* Summed from the SAME per-question counts the table below renders, so the
     headline and the table can never disagree about how much is outstanding.
     count_answers is the server's counter; this only adds its output up. */
  /* The concepts the verification card is already reporting on. Filtered by
     id rather than by name: a coach can retag between rounds, and two concepts
     can be renamed to match, but an id is the thing the card actually
     compared. */
  /* A retest's own stats restate what the verification card already said. */
  const isRetest = dashboard?.verification != null;
  const verifiedConceptIds = new Set(dashboard?.verification?.concept_ids ?? []);
  const teachNextConcepts = (dashboard?.concept_breakdown ?? []).filter(
    (c) => !verifiedConceptIds.has(c.concept_id),
  );

  const ungradedTotal = (dashboard?.question_breakdown ?? []).reduce(
    (total, q) => total + q.ungraded_count,
    0,
  );

  return (
    <div>
      <ErrorBanner message={error} />

      {dashboard && (
        <>
          {/* ON A RETEST, "WHAT CHANGED" COMES FIRST.
              A coach opening a retest's Results has one question, and it is
              not how the team scored - it is whether the players they sent it
              to are any different. Renders nothing on an ordinary quiz, so
              every other Results page is untouched. */}
          <RetestVerification verification={dashboard.verification} quizId={quiz.id} />

          {/* WHAT SHOULD I TEACH NEXT, FIRST.
              Results used to open with a team average - which answers "how did
              they do", a thing a coach can already feel by Wednesday. The
              average, the per-question table and the per-player responses are
              all still here, in that order, below: demoted to drill-down
              rather than removed, because they are how a coach checks the
              claim this panel makes.

              Renders nothing at all when no concept is tagged or nothing is
              graded yet, so a quiz that predates tagging - which is every quiz
              in Peira today - looks exactly as it did.

              ON A RETEST, THE VERIFIED CONCEPT IS ALREADY ANSWERED ABOVE.
              Leaving it here printed the same decision twice in a row - the
              same concept, the same remaining player, the same action - with
              the card and the panel disagreeing only in wording. The verified
              concept is dropped; ANY OTHER concept is kept, because a retest
              that exposes a second weakness is telling the coach something new
              and suppressing that would be worse than repeating the first. */}
          <WeakestConcepts concepts={teachNextConcepts} quizId={quiz.id} />

          {/* GRADING IS AN ACTION, so it sits above the grades rather than
              inside them. Only when there is something to do: an "0 answers
              need grading" line is a permanent piece of furniture. */}
          {ungradedTotal > 0 && (
            <p className={styles.needsGrading} role="status">
              <strong>
                {ungradedTotal} answer{ungradedTotal === 1 ? '' : 's'} need
                {ungradedTotal === 1 ? 's' : ''} grading
              </strong>{' '}
              &mdash; not counted right or wrong until you do.
            </p>
          )}

          {/* WHO TURNED IT IN, IN ONE SENTENCE.
              This was three cards - Responses, Roster size, Response rate -
              for what is really two facts, the third being the first two
              divided. Three tiles of analytics furniture sat between the
              coaching decision and the evidence that supports it, and
              "Roster size" is a database noun a coach would never say.

              ON A RETEST IT IS SUPPRESSED ENTIRELY. The verification card
              directly above has already said "This retest went to the 6
              players who missed it", and its roster IS the targeted group -
              so "6 Responses / 6 Roster size / 100%" restates the structure
              of the feature rather than telling anyone anything.

              AN EM DASH, NOT A MISSING NUMBER, when the denominator expired.
              roster_size counts who is eligible under the currently ACTIVE
              code; once that lapses it falls back to the quiz's own Roster,
              which is empty for a coach who activates against a Group.
              response_count is all-time and always true. Saying "10 turned it
              in" and naming what is unavailable keeps a coach able to tell "we
              never knew" from "this screen does not show it" - while still
              never printing the fabricated 0 that started all this. */}
          {!isRetest && (
            <p className={styles.turnedIn}>
              {hasResponseDenominator(dashboard.roster_size) ? (
                <>
                  <strong>{dashboard.response_count}</strong> of{' '}
                  <strong>{dashboard.roster_size}</strong> turned it in
                </>
              ) : (
                <>
                  <strong>{dashboard.response_count}</strong> turned it in{' '}
                  <span className={styles.turnedInNote}>
                    &mdash; out of how many is no longer recorded
                  </span>
                </>
              )}
            </p>
          )}

          {dashboard.missing_players.length > 0 && (
            <section className={styles.evidence}>
              <h2 className={styles.evidenceHeading}>
                Haven't submitted yet ({dashboard.missing_players.length})
              </h2>
              <div className={styles.missingList}>
                {dashboard.missing_players.map((name) => (
                  <span key={name} className={`${nb.badge} ${nb.badgeWarning}`}>
                    {name}
                  </span>
                ))}
              </div>
            </section>
          )}

          {dashboard.question_breakdown.length > 0 && (
            <section className={styles.evidence}>
              <h2 className={styles.evidenceHeading}>Per-question breakdown</h2>
              {/* The table is wider than a phone. It scrolls INSIDE this box
                  rather than taking the whole page sideways with it. */}
              <div className={styles.tableScroll}>
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
                        {/* Compact, inline, and visually quieter than the
                            question itself - it exists to let a coach scan to
                            "Q12", not to compete with the text. */}
                        <span className={styles.questionNumber}>Q{q.question_number}</span>
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
            </section>
          )}

          {/* EXPORTS COME AFTER THE ANSWER, NOT BEFORE IT.
              A coach opens Results to find out how their players did. These
              three buttons used to sit directly under the summary numbers, so
              on a 375px phone the first screen of the Results tab was the
              stats and then three ways to download a file - the scores
              themselves began below the fold.

              After the per-question breakdown and BEFORE the per-player list,
              deliberately. The order now reads: how did we do, who is missing,
              which questions did we miss, take it with you, then every
              individual answer. Below the per-player list would have been the
              other kind of wrong - with 24 players that list is 2,766px, and
              "give the position coach a PDF" is a real job.

              HONEST NUMBER: on a 20-question quiz this still puts the buttons
              3.6 screens down at 375px, because the breakdown table alone is
              1,948px. That is a presentation problem, not an ordering one -
              the right answer to it is a denser breakdown, which belongs to
              the visual pass and not to this change. */}
          <div className={styles.exportRow}>
            <span className={styles.exportLabel}>Export Results:</span>
            <button
              type="button"
              /* NOT GOLD ANY MORE. Gold on this screen means "the thing to do
                 about what you just read", and that is Retest. An export is
                 something a coach does occasionally and deliberately; giving
                 it the same treatment as the coaching action made the page
                 offer two equal answers to "what now?". Still the first and
                 most prominent of the three exports - just not competing. */
              className={nb.btnSm}
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
        </>
      )}

      {/* The deepest evidence, and the last thing on the page: one row per
          player, opened when a coach wants to see an individual's answers.
          Same treatment as the other evidence so the three read as one band
          rather than three competing panels. */}
      <h2 className={`${styles.evidenceHeading} ${styles.responsesHeading}`}>Player responses</h2>
      {responses === null ? (
        <LoadingState />
      ) : responses.length === 0 ? (
        <EmptyState message="No responses yet. Share the access code to start collecting them." />
      ) : (
        <div className={styles.responseList}>
          {responses.map((response) => (
            <ResponseRow
              key={response.id}
              quiz={quiz}
              response={response}
              exclusionsByQuestion={exclusionsByQuestion}
              assignments={assignmentsById}
              onChanged={load}
            />
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
