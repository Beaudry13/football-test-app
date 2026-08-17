import type { PlayerResultAnswer, PlayerResultsResponse } from '../../api/types';
import { resolveMediaUrl } from '../../api/client';
import { DrawingViewer } from '../../components/drawing/DrawingViewer';
import type { DrawingDocument } from '../../components/drawing/types';
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
            {/* THE SAME COMPONENT THE COACH SEES, over the same delivered
                image. Rendering the drawing here rather than the words
                "Drawing submitted" is the point of this phase - and reusing
                DrawingViewer is what stops the two sides from ever drawing the
                same answer differently. It takes an image url, a document and
                alt text, and nothing coach-only, so there is no privacy reason
                to fork it.

                The image comes from the DELIVERED record, so a coach replacing
                the picture afterwards cannot change what this player is shown.

                A drawing question with no drawing falls through to the text
                line below, which reads "No answer" - honest, and no viewer is
                mounted over a picture that has nothing on it. */}
            {answer.drawing ? (
              <div className={styles.answerDrawing}>
                <DrawingViewer
                  imageUrl={resolveMediaUrl(answer.drawing.image_url)}
                  document={answer.drawing.document as DrawingDocument}
                  alt={`Your drawing for: ${answer.question_text}`}
                />
              </div>
            ) : (
              <div className={styles.answerMeta}>
                Your answer: {answer.your_answer ?? <em>No answer</em>}
              </div>
            )}
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
