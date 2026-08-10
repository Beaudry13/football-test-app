import type { PracticeFeedback } from '../../api/types';
import { Icon } from '../../components/ui/Icon';
import styles from './PlayPage.module.css';

/** What a player is told after checking one practice answer.
 *
 * THE HONESTY RULE lives here. `is_correct` is null for anything Peira does
 * not score - Short Answer and Draw Response - and this renders "Response
 * recorded" for those rather than inventing a verdict a coach has not given.
 * It is the same rule that stops the coach-facing analytics reporting 0% when
 * nothing has been graded: never state a result nobody produced.
 *
 * The correct answer is deliberately absent. The server never sends it, and
 * the coach's explanation is the teaching mechanism - if they want the answer
 * revealed, they write it there.
 */
export function PracticeFeedbackCard({
  feedback,
  onContinue,
  continueLabel,
}: {
  feedback: PracticeFeedback;
  /** Omitted on the all-questions-on-one-page layout, where there is nothing
   * to advance to - the next question is already on screen. */
  onContinue?: () => void;
  continueLabel?: string;
}) {
  const verdict = !feedback.auto_gradable
    ? { tone: styles.feedbackRecorded, icon: 'check' as const, text: 'Response recorded' }
    : feedback.is_correct
      ? { tone: styles.feedbackCorrect, icon: 'check' as const, text: 'Correct' }
      : { tone: styles.feedbackIncorrect, icon: 'close' as const, text: 'Not quite' };

  return (
    <div className={`${styles.feedbackCard} ${verdict.tone}`} role="status" aria-live="polite">
      <div className={styles.feedbackVerdict}>
        <Icon name={verdict.icon} size={20} strokeWidth={3} />
        <strong>{verdict.text}</strong>
      </div>

      {!feedback.auto_gradable && (
        <p className={styles.feedbackNote}>Your coach will review this one.</p>
      )}

      {feedback.answer_explanation && (
        <p className={styles.feedbackExplanation}>{feedback.answer_explanation}</p>
      )}

      {onContinue && (
        <button type="button" className="btn btn-primary" onClick={onContinue}>
          {continueLabel}
        </button>
      )}
    </div>
  );
}
