import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { gradeAnswer, resetAttempt } from '../../api/grading';
import { getErrorMessage } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import type { Answer, PlayerResponse, Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import nb from '../../styles/notebook.module.css';
import styles from './ResultsTab.module.css';

function AnswerRow({
  answer,
  quiz,
  onChanged,
}: {
  answer: Answer;
  quiz: Quiz;
  onChanged: () => void;
}) {
  const question = quiz.questions?.find((q) => q.id === answer.question_id);
  const [feedback, setFeedback] = useState(answer.coach_feedback ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!question) return null;

  const selectedOption = question.options.find((o) => o.id === answer.selected_option_id);
  const needsManualGrading = question.question_type === 'written';

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

  return (
    <div className={styles.answerRow}>
      <div className={styles.answerQuestion}>{question.question_text}</div>
      <div className={styles.answerValue}>
        {selectedOption ? selectedOption.option_text : answer.answer_text || <em>No answer</em>}
      </div>

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
    </div>
  );
}

export function ResponseRow({
  quiz,
  response,
  onChanged,
}: {
  quiz: Quiz;
  response: PlayerResponse;
  onChanged: () => void;
}) {
  const { coach } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();
  const answers = response.answers ?? [];
  const gradedCorrect = answers.filter((a) => a.is_correct === true).length;
  const pendingGrading = answers.filter(
    (a) => a.is_correct === null && quiz.questions?.find((q) => q.id === a.question_id)?.question_type === 'written',
  ).length;
  // Mirrors the backend's get_editable_quiz rule so the UI doesn't offer an
  // action the API will refuse - the server is still the enforcement point.
  const canReset = coach != null && (coach.id === quiz.coach_id || coach.role === 'admin');

  async function handleReset(event: ReactMouseEvent) {
    event.stopPropagation();
    setError(null);
    try {
      await confirm({
        title: 'Reset Attempt?',
        body: `${response.player_name}'s answers and any grading or feedback on them will be permanently deleted, and they can start the Peira fresh. This action cannot be undone.`,
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
      <div className={styles.responseHeader} onClick={() => setIsOpen((v) => !v)}>
        <div>
          <Link
            to={`/players/${encodeURIComponent(response.player_name)}/history`}
            className={styles.playerNameLink}
            onClick={(e) => e.stopPropagation()}
          >
            {response.player_name}
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
          <span>{isOpen ? '▲' : '▼'}</span>
        </div>
      </div>
      <ErrorBanner message={error} />
      {isOpen && answers.map((answer) => (
        <AnswerRow key={answer.id} answer={answer} quiz={quiz} onChanged={onChanged} />
      ))}
    </div>
  );
}
