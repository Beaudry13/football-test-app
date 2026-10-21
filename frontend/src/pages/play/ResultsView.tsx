import type { PlayerResultAnswer, PlayerResultsResponse } from '../../api/types';
import { resolveMediaUrl } from '../../api/client';
import { DrawingViewer } from '../../components/drawing/DrawingViewer';
import type { DrawingDocument } from '../../components/drawing/types';
import { YouAre } from '../../components/football/DecisionWords';
import { PlayPicture } from '../../components/football/PlayPicture';
import styles from './PlayPage.module.css';
import review from './ResultsReview.module.css';

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

/** A missed answer that still counts - the ones worth a second look. */
const isMiss = (answer: PlayerResultAnswer) => !answer.is_excluded && answer.is_correct === false;

/**
 * A GRADED QUIZ'S RESULTS: how it went, then WHAT YOU MISSED - each miss on
 * the football picture it was asked on (the delivered one), with his answer
 * and the correct one - then the rest.
 *
 * THE ANSWER-REVEAL POLICY IS THE SERVER'S AND DOES NOT MOVE HERE. The correct
 * answer appears exactly where the page always showed it (in words, never for
 * an excluded question); nothing marks options on the picture, and the
 * question's explanation is not part of graded results.
 */
export function ResultsView({ results }: { results: PlayerResultsResponse }) {
  const counted = results.answers.filter((a) => !a.is_excluded);
  const correct = counted.filter((a) => a.is_correct === true).length;
  const missed = results.answers.filter(isMiss);
  const pending = counted.filter((a) => a.is_correct === null).length;
  const scored = correct + missed.length;
  const rest = results.answers.filter((a) => !isMiss(a));

  return (
    <div className={styles.panel}>
      <div className={`card ${styles.summaryStat}`}>
        <h1>{results.quiz_title}</h1>
        <p>Results for {results.player_name}</p>
        {/* How it went, in one line - never a percentage nobody graded. */}
        {scored > 0 && (
          <p className={review.score}>
            <strong>
              {correct} of {scored}
            </strong>{' '}
            correct
          </p>
        )}
        {pending > 0 && (
          <p className={review.pending}>
            {pending} {pending === 1 ? 'answer is' : 'answers are'} waiting on your coach.
          </p>
        )}
      </div>

      {missed.length > 0 && (
        <section className={review.missed} aria-label="What you missed">
          <h2 className={review.heading}>What you missed</h2>
          {missed.map((answer) => (
            <MissedCard key={answer.question_id ?? answer.question_number} answer={answer} />
          ))}
        </section>
      )}

      {rest.length > 0 && (
        <section aria-label={missed.length > 0 ? 'The rest' : 'Your answers'}>
          {missed.length > 0 && <h2 className={review.heading}>The rest</h2>}
          <div className={styles.resultsList}>
            {rest.map((answer) => (
              <AnswerCard key={answer.question_id ?? answer.question_number} answer={answer} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** A miss, on the football: who he was, the picture, the question, his answer
 *  and the correct one - then whatever the coach wrote him. */
function MissedCard({ answer }: { answer: PlayerResultAnswer }) {
  return (
    <div className={`card ${review.missedCard}`}>
      {answer.drawing ? (
        <AnswerDrawing answer={answer} />
      ) : (
        answer.image && (
          <>
            {answer.subject_role && <YouAre role={answer.subject_role} />}
            <PlayPicture
              image={answer.image}
              still
              marker={answer.subject_marker}
              pictureClassName={review.picture}
              alt={`The play for: ${answer.question_text}`}
            />
          </>
        )
      )}
      <h3 className={review.prompt}>{answer.question_text}</h3>
      {!answer.drawing && (
        <p className={review.yours}>Your answer: {answer.your_answer ?? <em>No answer</em>}</p>
      )}
      {answer.correct_answer && <p className={review.right}>Correct answer: {answer.correct_answer}</p>}
      {/* No "Incorrect" badge: the section it sits in already says so. */}
      {answer.coach_feedback && (
        <div className={styles.feedback}>
          <strong>Coach feedback:</strong> {answer.coach_feedback}
        </div>
      )}
    </div>
  );
}

/* THE SAME COMPONENT THE COACH SEES, over the same delivered image. Rendering
   the drawing here rather than the words "Drawing submitted" is the point -
   and reusing DrawingViewer is what stops the two sides from ever drawing the
   same answer differently. The image comes from the DELIVERED record, so a
   coach replacing the picture afterwards cannot change what this player is
   shown. */
function AnswerDrawing({ answer }: { answer: PlayerResultAnswer }) {
  if (!answer.drawing) return null;
  return (
    <div className={styles.answerDrawing}>
      <DrawingViewer
        imageUrl={resolveMediaUrl(answer.drawing.image_url)}
        document={answer.drawing.document as DrawingDocument}
        alt={`Your drawing for: ${answer.question_text}`}
      />
    </div>
  );
}

function AnswerCard({ answer }: { answer: PlayerResultAnswer }) {
  return (
    <div className="card">
      <div className={styles.answerQuestion}>{answer.question_text}</div>
      {/* The player's own answer is shown for an excluded question too.
          Exclusion sets a question aside; it does not erase what they wrote,
          and hiding it would read as a penalty. A drawing question with no
          drawing falls through to the text line, which reads "No answer" -
          honest, and no viewer is mounted over a picture with nothing on it. */}
      {answer.drawing ? (
        <AnswerDrawing answer={answer} />
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
  );
}
