import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getQuiz } from '../../api/quizzes';
import { getQuizDashboard, gradeAnswer, listResponses } from '../../api/grading';
import { getErrorMessage, resolveMediaUrl } from '../../api/client';
import type { PlayerResponse, Quiz, QuizDashboard } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { DrawingViewer } from '../../components/drawing/DrawingViewer';
import type { DrawingDocument } from '../../components/drawing/types';
import {
  buildGradingQueue,
  countAwaitingGrades,
  type GradeQuestion,
  type GradeTarget,
} from './gradingQueue';
import nb from '../../styles/notebook.module.css';
import styles from './GradeResponsesPage.module.css';

/** ONE QUESTION, EVERY ANSWER TO IT, ONE STANDARD IN THE COACH'S HEAD.
 *
 * The measured problem this exists to solve is not clicks. Grading a 24-player
 * quiz with six written questions through the player-first list costs 168
 * clicks and 144 QUESTION-CONTEXT SWITCHES: the coach reads a different
 * question before nearly every decision, because a player's answers are
 * interleaved with the fourteen auto-graded ones nobody needs to look at.
 * Here the same 144 decisions cost six context loads.
 *
 * So the question is stated ONCE, at the top, and never repeated per player.
 * Repeating it would rebuild exactly the cost this screen removes.
 *
 * This screen makes decisions and nothing else. It does not compute a score,
 * a concept, a miss rate or a retest - Results already interprets
 * `answers.is_correct`, and duplicating any of that here would create a second
 * opinion about the same data.
 */
export function GradeResponsesPage() {
  const { quizId } = useParams<{ quizId: string }>();
  const id = Number(quizId);

  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [responses, setResponses] = useState<PlayerResponse[]>([]);
  const [dashboard, setDashboard] = useState<QuizDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Which question of the queue is on screen. An INDEX, not an id, because
   *  the coach moves through a list rather than jumping to a known question. */
  const [index, setIndex] = useState(0);
  /** Answers currently being written, so a double-click cannot fire twice and
   *  the button can show it is working without blocking the others. */
  const [saving, setSaving] = useState<ReadonlySet<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const [loadedQuiz, loadedResponses, loadedDashboard] = await Promise.all([
        getQuiz(id),
        listResponses(id),
        getQuizDashboard(id),
      ]);
      setQuiz(loadedQuiz);
      setResponses(loadedResponses);
      setDashboard(loadedDashboard);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The questions a coach may act on. Excluded ones are removed HERE, from
   *  the dashboard's own exclusion flags, so this screen and the Results
   *  breakdown cannot disagree about which questions still count. */
  const excludedIds = useMemo(
    () =>
      new Set(
        (dashboard?.question_breakdown ?? [])
          .filter((q) => q.is_excluded)
          .map((q) => q.question_id),
      ),
    [dashboard],
  );

  const queue = useMemo<GradeQuestion[]>(
    () => (quiz ? buildGradingQueue(quiz, responses, excludedIds) : []),
    [quiz, responses, excludedIds],
  );

  const remaining = countAwaitingGrades(queue);

  /** THE QUEUE DOES NOT RESHUFFLE UNDER THE COACH.
   *
   * `queue` is rebuilt from fresh data after every grade, so a question whose
   * last response was just decided still holds its place. Dropping finished
   * questions out from under the cursor would move the next question onto the
   * button the coach is about to press. They advance deliberately instead. */
  const current: GradeQuestion | undefined = queue[Math.min(index, queue.length - 1)];

  /** The next question that still has work, after this one. */
  const nextUngradedIndex = useMemo(() => {
    for (let i = index + 1; i < queue.length; i += 1) {
      if (queue[i].ungradedCount > 0) return i;
    }
    // Nothing after it - wrap to anything still outstanding before it, so
    // "next" always means "more work" rather than "further down the list".
    for (let i = 0; i < index; i += 1) {
      if (queue[i].ungradedCount > 0) return i;
    }
    return null;
  }, [queue, index]);

  async function grade(target: GradeTarget, isCorrect: boolean) {
    setError(null);
    setSaving((current) => new Set(current).add(target.answerId));
    try {
      // The existing write path, unchanged: one answer, by id. It already
      // takes no quiz, player or question, which is why this screen needed no
      // endpoint of its own.
      await gradeAnswer(target.answerId, { is_correct: isCorrect, coach_feedback: null });
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving((current) => {
        const next = new Set(current);
        next.delete(target.answerId);
        return next;
      });
    }
  }

  if (loading) return <LoadingState label="Loading responses" />;

  if (error && quiz === null) {
    return (
      <div>
        <ErrorBanner message={error} />
        <Link to={`/quizzes/${id}`} className={nb.btnSecondary}>
          Back to the quiz
        </Link>
      </div>
    );
  }

  const backToResults = (
    <Link to={`/quizzes/${id}`} className={styles.back}>
      &larr; {quiz?.title ?? 'Back to results'}
    </Link>
  );

  /* NOTHING TO DO IS A COMPLETE ANSWER, not an empty list. A coach who
     arrives here with everything graded - or who has just finished - should be
     told so and sent back, not left looking at a screen asking them to work
     out why it is blank. */
  if (remaining === 0) {
    return (
      <div className={styles.page}>
        {backToResults}
        <div className={styles.done}>
          <h1 className={styles.doneHeading}>All caught up</h1>
          <p className={styles.doneLine}>
            {queue.length === 0
              ? 'Nothing on this quiz needs grading by hand.'
              : 'Every response has a decision.'}
          </p>
          <Link to={`/quizzes/${id}`} className={nb.btnPrimary}>
            Back to results
          </Link>
        </div>
      </div>
    );
  }

  if (!current) return null;

  return (
    <div className={styles.page}>
      {backToResults}
      <ErrorBanner message={error} />

      {/* THE QUESTION ANCHORS THE SCREEN. Stated once, largest thing here,
          with the accepted answers under it as the standard being applied -
          because the coach is holding one standard and applying it to
          everything below. */}
      <header className={styles.header}>
        <p className={styles.progress}>
          Question {current.questionNumber}
          {' · '}
          {current.ungradedCount === 0
            ? 'all graded'
            : `${current.ungradedCount} left`}
          {' · '}
          {remaining} left on this quiz
        </p>
        <h1 className={styles.question}>{current.questionText}</h1>
        {current.expectedAnswers.length > 0 && (
          <p className={styles.accepted}>
            <span className={styles.acceptedLabel}>Accepted</span>
            {current.expectedAnswers.join(' · ')}
          </p>
        )}
      </header>

      <ol className={styles.responses}>
        {current.targets.map((target) => (
          <GradeRow
            key={target.answerId}
            target={target}
            questionType={current.questionType}
            questionText={current.questionText}
            busy={saving.has(target.answerId)}
            onGrade={(isCorrect) => void grade(target, isCorrect)}
          />
        ))}
      </ol>

      <div className={styles.foot}>
        {nextUngradedIndex !== null ? (
          <button
            type="button"
            className={nb.btnPrimary}
            onClick={() => {
              setIndex(nextUngradedIndex);
              window.scrollTo({ top: 0 });
            }}
          >
            Next question &rarr;
          </button>
        ) : (
          <Link to={`/quizzes/${id}`} className={nb.btnPrimary}>
            Back to results
          </Link>
        )}
      </div>
    </div>
  );
}

/** One player's answer, and the call.
 *
 * A graded row STAYS, marked. Removing it the instant it is decided would make
 * a misclick invisible at exactly the moment it is most likely - the coach is
 * moving fast and looking at the next answer, not the one they just left.
 */
function GradeRow({
  target,
  questionType,
  questionText,
  busy,
  onGrade,
}: {
  target: GradeTarget;
  questionType: string;
  questionText: string;
  busy: boolean;
  onGrade: (isCorrect: boolean) => void;
}) {
  const isDrawing = questionType === 'draw_response';
  // The image THIS player was delivered, not today's copy of the question, so
  // the strokes sit on the picture they were drawn on.
  const image = target.delivered?.image ?? null;

  return (
    <li
      className={`${styles.row} ${target.isCorrect === true ? styles.rowCorrect : ''} ${
        target.isCorrect === false ? styles.rowIncorrect : ''
      }`}
    >
      <p className={styles.player}>{target.playerName}</p>

      {isDrawing ? (
        target.drawing && image ? (
          <div className={styles.drawing}>
            <DrawingViewer
              imageUrl={resolveMediaUrl(image.image_url)}
              document={target.drawing.document as DrawingDocument}
              alt={`Drawing by ${target.playerName} for: ${questionText}`}
            />
          </div>
        ) : (
          <p className={styles.empty}>
            <em>{image ? 'Nothing drawn' : 'This question is missing its image'}</em>
          </p>
        )
      ) : target.answerText ? (
        <p className={styles.answer}>{target.answerText}</p>
      ) : (
        <p className={styles.empty}>
          <em>Left blank</em>
        </p>
      )}

      <div className={styles.actions}>
        {/* The current decision is visible on the buttons themselves rather
            than in a separate badge: the thing that says what was decided is
            the thing that changes it. */}
        <button
          type="button"
          className={`${styles.verdict} ${target.isCorrect === true ? styles.verdictCorrect : ''}`}
          aria-pressed={target.isCorrect === true}
          disabled={busy}
          onClick={() => onGrade(true)}
        >
          ✓ Correct
        </button>
        <button
          type="button"
          className={`${styles.verdict} ${
            target.isCorrect === false ? styles.verdictIncorrect : ''
          }`}
          aria-pressed={target.isCorrect === false}
          disabled={busy}
          onClick={() => onGrade(false)}
        >
          ✕ Incorrect
        </button>
      </div>
    </li>
  );
}
