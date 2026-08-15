import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { gradeAnswer, resetAttempt } from '../../api/grading';
import { getErrorMessage } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import type {
  Answer,
  DeliveredQuestion,
  PlayerResponse,
  QuestionExclusion,
  Quiz,
  QuizAssignment,
} from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { Icon } from '../../components/ui/Icon';
import { DrawingViewer } from '../../components/drawing/DrawingViewer';
import { resolveMediaUrl } from '../../api/client';
import type { DrawingDocument } from '../../components/drawing/types';
import nb from '../../styles/notebook.module.css';
import { describeExclusionScope } from './assignmentLabel';
import styles from './ResultsTab.module.css';

/** Shared empty default, so an unsupplied lookup does not allocate a new Map
 *  on every render and retrigger memoised children. */
const EMPTY_ASSIGNMENTS = new Map<number, QuizAssignment>();

function AnswerRow({
  answer,
  quiz,
  delivered,
  exclusions,
  assignments,
  onChanged,
}: {
  answer: Answer;
  quiz: Quiz;
  /** WHAT THIS ATTEMPT RECEIVED. Snapshot-backed, so a corrected live question
   *  cannot retitle or renumber a result the player already has. Absent only
   *  for a payload that predates Phase 4a, where the live question is used. */
  delivered?: DeliveredQuestion;
  /** Active exclusions covering this question, if any. */
  exclusions?: QuestionExclusion[];
  assignments: Map<number, QuizAssignment>;
  onChanged: () => void;
}) {
  const live = quiz.questions?.find((q) => q.id === answer.question_id);
  // Delivered content wins wherever it exists; the live question is only a
  // fallback, never a correction of the record.
  const question = delivered ?? live;
  const questionNumber = delivered?.question_number;
  const [feedback, setFeedback] = useState(answer.coach_feedback ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!question) return null;

  const questionText = delivered ? delivered.question_text : live!.question_text;
  const questionType = question.question_type;
  const questionImage = delivered ? delivered.image : live!.image;
  const selectedOption = question.options.find((o) => o.id === answer.selected_option_id);
  // Both types are judged by a person rather than scored from an option. The
  // grading UI itself is Phase 4; this only decides what the coach is shown.
  //
  // fill_blank is deliberately NOT here: it is scored the moment the player
  // types, so offering a coach a Correct/Incorrect button for one would invite
  // them to overrule a decision the server already made and recorded.
  const needsManualGrading = questionType === 'written' || questionType === 'draw_response';
  const isDrawResponse = questionType === 'draw_response';

  async function handleGrade(isCorrect: boolean) {
    setError(null);
    setIsSaving(true);
    try {
      await gradeAnswer(answer.id, { is_correct: isCorrect, coach_feedback: feedback || null });
      onChanged();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }

  // This question no longer counts. The coach's other surfaces - the
  // per-question breakdown, the PDF, the CSV, and the player's own results
  // page - all say so; before this, the expanded response was the one place
  // that stayed silent and showed a bare Correct/Incorrect.
  const activeExclusions = exclusions ?? [];
  const isExcluded = activeExclusions.length > 0;

  return (
    <div className={`${styles.answerRow} ${isExcluded ? styles.answerExcluded : ''}`}>
      <div className={styles.answerQuestion}>
        {questionNumber !== undefined && (
          <span className={styles.questionNumber}>Q{questionNumber}</span>
        )}
        {questionText}
      </div>
      {isDrawResponse ? (
        answer.drawing && questionImage ? (
          <DrawingViewer
            imageUrl={resolveMediaUrl(questionImage.image_url)}
            document={answer.drawing.document as DrawingDocument}
            alt={`Drawing submitted for: ${questionText}`}
          />
        ) : (
          <div className={styles.answerValue}>
            <em>{questionImage ? 'Nothing drawn' : 'This question is missing its image'}</em>
          </div>
        )
      ) : (
        <div className={styles.answerValue}>
          {selectedOption ? selectedOption.option_text : answer.answer_text || <em>No answer</em>}
        </div>
      )}

      <ErrorBanner message={error} />

      {needsManualGrading ? (
        <div className={styles.gradingRow}>
          <textarea
            placeholder="Feedback for this player (optional)"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <button
            className={`${nb.btnSm} ${answer.is_correct === true ? styles.gradeCorrect : ''}`}
            disabled={isSaving}
            onClick={() => handleGrade(true)}
          >
            ✓ Correct
          </button>
          <button
            className={`${nb.btnSm} ${answer.is_correct === false ? styles.gradeIncorrect : ''}`}
            disabled={isSaving}
            onClick={() => handleGrade(false)}
          >
            ✕ Incorrect
          </button>
          {answer.graded_at && <span className={`${nb.badge} ${nb.badgeNeutral}`}>Graded</span>}
          {answer.graded_by_username && (
            <span className={styles.gradedBy}>Graded by {answer.graded_by_username}</span>
          )}
        </div>
      ) : (
        <span className={`${nb.badge} ${answer.is_correct ? nb.badgeSuccess : nb.badgeWarning}`}>
          {answer.is_correct ? 'Correct' : 'Incorrect'}
        </span>
      )}

      {/* Placed AFTER the verdict rather than replacing it. The stored grade is
          evidence and the coach keeps seeing it - and for a manually graded
          question they must still be able to grade it, because restoring the
          exclusion would otherwise leave the answer unmarked. This says the
          grade no longer counts, not that it no longer exists. */}
      {isExcluded && (
        <div className={styles.answerExcludedNote}>
          <span className={`${nb.badge} ${nb.badgeWarning}`}>Excluded from scoring</span>
          {activeExclusions.map((ex) => (
            <span key={ex.id}>
              Not counted for{' '}
              {describeExclusionScope(ex.scope, ex.access_code_id, assignments)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function ResponseRow({
  quiz,
  response,
  exclusionsByQuestion,
  assignments,
  onChanged,
}: {
  quiz: Quiz;
  response: PlayerResponse;
  /** question_id -> active exclusions covering it. */
  exclusionsByQuestion?: Map<number, QuestionExclusion[]>;
  assignments?: Map<number, QuizAssignment>;
  onChanged: () => void;
}) {
  const { coach } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();
  const answers = response.answers ?? [];
  // WHAT THIS ATTEMPT RECEIVED, keyed for lookup. Comes with the response
  // payload, so the numbering and content here are the player's own rather
  // than the live quiz's.
  const deliveredById = new Map(
    (response.delivered_questions ?? [])
      .filter((d) => d.question_id !== null)
      .map((d) => [d.question_id as number, d]),
  );
  const isExcluded = (questionId: number) =>
    (exclusionsByQuestion?.get(questionId)?.length ?? 0) > 0;

  // THE SUMMARY BADGE IS A SCORE, NOT A TALLY OF STORED VERDICTS.
  //
  // It sits in the player's summary row in success colours and reads as "how
  // did they do", so it has to mean CORRECT ANSWERS THAT CURRENTLY COUNT.
  // Leaving it raw produced a three-way contradiction about one player: the
  // badge said 12, the expanded rows showed 11 counted plus one marked
  // "Excluded from scoring", and the PDF said 11.
  //
  // The evidence is NOT lost - the expanded row below still shows the stored
  // Correct/Incorrect verdict alongside the excluded marker. That is the right
  // place to show both truths; this is the place to show the current result.
  // Nothing is regraded: answers.is_correct is untouched.
  const gradedCorrect = answers.filter(
    (a) => a.is_correct === true && !isExcluded(a.question_id),
  ).length;

  // DELIBERATELY NOT exclusion-filtered, and not the same bug. This is a WORK
  // QUEUE ("N to grade"), not a scored result: a coach still owes a grade on an
  // excluded written answer, because restoring the question would otherwise
  // leave it unmarked. Mirrors services/scoring.pending_grading_count, which
  // makes the same choice for the same reason.
  //
  // The TYPE comes from the delivered record, not the live question. A
  // historical component must not mix snapshot semantics for display with
  // live-type interpretation for grading state - one source, consistently.
  // (Type edits are blocked once answered, so this changes no count today; it
  // stops the two from being able to diverge at all.)
  const pendingGrading = answers.filter((a) => {
    const type =
      deliveredById.get(a.question_id)?.question_type ??
      quiz.questions?.find((q) => q.id === a.question_id)?.question_type;
    return a.is_correct === null && type === 'written';
  }).length;
  // Mirrors the backend's get_editable_quiz rule so the UI doesn't offer an
  // action the API will refuse - the server is still the enforcement point.
  const canReset = coach != null && (coach.id === quiz.coach_id || coach.role === 'admin');

  async function handleReset(event: ReactMouseEvent) {
    event.stopPropagation();
    setError(null);
    try {
      await confirm({
        title: 'Reset Attempt?',
        body: `${response.display_name}'s answers and any grading or feedback on them will be permanently deleted, and they can start the Quiz fresh. This action cannot be undone.`,
        confirmLabel: 'Reset Attempt',
        action: async () => {
          setIsResetting(true);
          await resetAttempt(quiz.id, response.id);
          onChanged();
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
      setIsResetting(false);
    }
  }

  return (
    <div className={nb.card}>
      {dialog}
      {/* role=button rather than a real <button>: this header contains a
          <Link> to the player's history, and nesting an <a> inside a
          <button> is invalid HTML. Keyboard support and aria-expanded are
          wired by hand so the accordion works without a mouse. */}
      <div
        className={styles.responseHeader}
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        aria-label={`${isOpen ? 'Collapse' : 'Expand'} answers for ${response.display_name}`}
        onClick={() => setIsOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsOpen((v) => !v);
          }
        }}
      >
        <div>
          <Link
            // The legacy name-based history page is keyed by the historical
            // snapshot, not the live name - the link target intentionally
            // stays player_name even though the label below shows the
            // current canonical name.
            to={`/players/${encodeURIComponent(response.player_name)}/history`}
            className={styles.playerNameLink}
            onClick={(e) => e.stopPropagation()}
          >
            {response.display_name}
          </Link>
          <span className={styles.responseMeta}>{new Date(response.submitted_at).toLocaleString()}</span>
        </div>
        <div className={styles.responseActions}>
          <span className={`${nb.badge} ${nb.badgeSuccess}`}>{gradedCorrect} correct</span>
          {pendingGrading > 0 && (
            <span className={`${nb.badge} ${nb.badgeWarning}`}>{pendingGrading} to grade</span>
          )}
          {canReset && (
            <button
              className={`${nb.btnSm} ${nb.btnDanger}`}
              onClick={handleReset}
              disabled={isResetting}
            >
              {isResetting ? 'Resetting…' : 'Reset attempt'}
            </button>
          )}
          <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={16} />
        </div>
      </div>
      <ErrorBanner message={error} />
      {isOpen && answers.map((answer) => (
        <AnswerRow
          key={answer.id}
          answer={answer}
          quiz={quiz}
          delivered={deliveredById.get(answer.question_id)}
          exclusions={exclusionsByQuestion?.get(answer.question_id)}
          assignments={assignments ?? EMPTY_ASSIGNMENTS}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}
