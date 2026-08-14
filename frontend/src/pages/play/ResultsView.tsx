import type { PlayerResultAnswer, PlayerResultsResponse } from '../../api/types';
import styles from './PlayPage.module.css';

/** THE HONESTY RULE, same as PracticeFeedbackCard's.
 *
 * An excluded question is checked FIRST and never falls through to a verdict:
 * `is_correct` is null for it exactly as it is for an ungraded answer, so
 * reading the null alone would tell a player their coach is still marking a
 * question that is no longer being marked at all. */
function StatusBadge({ answer }: { answer: PlayerResultAnswer }) {
  if (answer.is_excluded) {
    return <span className="badge badge-neutral">Excluded from scoring</span>;
  }
  if (answer.is_correct === null) return <span className="badge badge-neutral">Pending review</span>;
  if (answer.is_correct) return <span className="badge badge-success">Correct</span>;
  return <span className="badge badge-warning">Incorrect</span>;
}

export function ResultsView({ results }: { results: PlayerResultsResponse }) {
  return (
    <div className={styles.panel}>
      <div className={`card ${styles.summaryStat}`}>
        <h1>{results.quiz_title}</h1>
        <p>Results for {results.player_name}</p>
      </div>

      <div className={styles.resultsList}>
        {results.answers.map((answer) => (
          <div key={answer.question_id} className="card">
            <div className={styles.answerQuestion}>{answer.question_text}</div>
            {/* The player's own answer is shown for an excluded question too.
                Exclusion sets a question aside; it does not erase what they
                wrote, and hiding it would read as a penalty. */}
            <div className={styles.answerMeta}>
              Your answer: {answer.your_answer ?? <em>No answer</em>}
            </div>
            {!answer.is_excluded && answer.is_correct === false && answer.correct_answer && (
              <div className={styles.answerMeta}>Correct answer: {answer.correct_answer}</div>
            )}
            <StatusBadge answer={answer} />
            {answer.is_excluded && (
              // Plain, and deliberately without the coach's private reason -
              // that note is for the coach and the audit trail, not the player.
              <div className={styles.answerMeta}>
                Your coach removed this question from scoring. It is not counted
                as right or wrong.
              </div>
            )}
            {answer.coach_feedback && (
              <div className={styles.feedback}>
                <strong>Coach feedback:</strong> {answer.coach_feedback}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
