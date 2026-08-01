import { useState } from 'react';
import { gradeAnswer } from '../../api/grading';
import { getErrorMessage } from '../../api/client';
import type { Answer, PlayerResponse, Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import styles from './ResultsTab.module.css';

function AnswerRow({
  answer,
  quiz,
  onGraded,
}: {
  answer: Answer;
  quiz: Quiz;
  onGraded: () => void;
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
      onGraded();
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
            className="btn btn-secondary btn-sm"
            disabled={isSaving}
            onClick={() => handleGrade(true)}
            style={answer.is_correct === true ? { borderColor: 'var(--color-success)' } : undefined}
          >
            ✓ Correct
          </button>
          <button
            className="btn btn-secondary btn-sm"
            disabled={isSaving}
            onClick={() => handleGrade(false)}
            style={answer.is_correct === false ? { borderColor: 'var(--color-danger)' } : undefined}
          >
            ✕ Incorrect
          </button>
          {answer.graded_at && <span className="badge badge-neutral">Graded</span>}
        </div>
      ) : (
        <span className={`badge ${answer.is_correct ? 'badge-success' : 'badge-warning'}`}>
          {answer.is_correct ? 'Correct' : 'Incorrect'}
        </span>
      )}
    </div>
  );
}

export function ResponseRow({
  quiz,
  response,
  onGraded,
}: {
  quiz: Quiz;
  response: PlayerResponse;
  onGraded: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const answers = response.answers ?? [];
  const gradedCorrect = answers.filter((a) => a.is_correct === true).length;
  const pendingGrading = answers.filter(
    (a) => a.is_correct === null && quiz.questions?.find((q) => q.id === a.question_id)?.question_type === 'written',
  ).length;

  return (
    <div className="card">
      <div className={styles.responseHeader} onClick={() => setIsOpen((v) => !v)}>
        <div>
          <strong>{response.player_name}</strong>
          <span style={{ color: 'var(--color-text-muted)', marginLeft: '0.75em', fontSize: '0.85em' }}>
            {new Date(response.submitted_at).toLocaleString()}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.5em', alignItems: 'center' }}>
          <span className="badge badge-success">{gradedCorrect} correct</span>
          {pendingGrading > 0 && <span className="badge badge-warning">{pendingGrading} to grade</span>}
          <span>{isOpen ? '▲' : '▼'}</span>
        </div>
      </div>
      {isOpen && answers.map((answer) => (
        <AnswerRow key={answer.id} answer={answer} quiz={quiz} onGraded={onGraded} />
      ))}
    </div>
  );
}
