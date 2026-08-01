import type { PlayerResultsResponse } from '../../api/types';
import styles from './PlayPage.module.css';

function StatusBadge({ isCorrect }: { isCorrect: boolean | null }) {
  if (isCorrect === null) return <span className="badge badge-neutral">Pending review</span>;
  if (isCorrect) return <span className="badge badge-success">Correct</span>;
  return <span className="badge badge-warning">Incorrect</span>;
}

export function ResultsView({ results }: { results: PlayerResultsResponse }) {
  return (
    <div className={styles.panel}>
      <div className={`card ${styles.summaryStat}`}>
        <h2>{results.quiz_title}</h2>
        <p>Results for {results.player_name}</p>
      </div>

      <div className={styles.resultsList}>
        {results.answers.map((answer) => (
          <div key={answer.question_id} className="card">
            <div className={styles.answerQuestion}>{answer.question_text}</div>
            <div className={styles.answerMeta}>
              Your answer: {answer.your_answer ?? <em>No answer</em>}
            </div>
            {answer.is_correct === false && answer.correct_answer && (
              <div className={styles.answerMeta}>Correct answer: {answer.correct_answer}</div>
            )}
            <StatusBadge isCorrect={answer.is_correct} />
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
