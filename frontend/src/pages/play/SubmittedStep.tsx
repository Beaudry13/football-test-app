import type { PlayerResponse } from '../../api/types';
import styles from './PlayPage.module.css';

export function SubmittedStep({ response }: { response: PlayerResponse }) {
  const answers = response.answers ?? [];
  const graded = answers.filter((a) => a.is_correct !== null);
  const correct = graded.filter((a) => a.is_correct).length;
  const pending = answers.length - graded.length;

  return (
    <div className={`card ${styles.panel} ${styles.summaryStat}`}>
      <h2>Nice work, {response.player_name}!</h2>
      <p>Your answers have been submitted.</p>
      {graded.length > 0 && (
        <p>
          <strong>
            {correct} / {graded.length}
          </strong>{' '}
          correct on auto-graded questions.
        </p>
      )}
      {pending > 0 && <p>{pending} question(s) are awaiting your coach's review.</p>}
    </div>
  );
}
