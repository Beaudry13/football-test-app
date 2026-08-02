import { useState } from 'react';
import { gradeAnswer } from '../../api/grading';
import { getErrorMessage } from '../../api/client';
import type { Answer, PlayerResponse, Quiz } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import nb from '../../styles/notebook.module.css';
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
    <div className={nb.card}>
      <div className={styles.responseHeader} onClick={() => setIsOpen((v) => !v)}>
        <div>
          <strong>{response.player_name}</strong>
          <span className={styles.responseMeta}>{new Date(response.submitted_at).toLocaleString()}</span>
        </div>
        <div className={styles.responseActions}>
          <span className={`${nb.badge} ${nb.badgeSuccess}`}>{gradedCorrect} correct</span>
          {pendingGrading > 0 && (
            <span className={`${nb.badge} ${nb.badgeWarning}`}>{pendingGrading} to grade</span>
          )}
          <span>{isOpen ? '▲' : '▼'}</span>
        </div>
      </div>
      {isOpen && answers.map((answer) => (
        <AnswerRow key={answer.id} answer={answer} quiz={quiz} onGraded={onGraded} />
      ))}
    </div>
  );
}
