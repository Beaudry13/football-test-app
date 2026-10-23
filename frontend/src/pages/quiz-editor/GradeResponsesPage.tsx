import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getQuiz } from '../../api/quizzes';
import { getQuizDashboard, gradeAnswer, listResponses, listToGrade, type ToGrade } from '../../api/grading';
import { getErrorMessage, resolveMediaUrl } from '../../api/client';
import type { PlayerResponse, Quiz, QuizDashboard } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { CompareDrawing } from '../../components/drawing/CompareDrawing';
import { DrawingViewer } from '../../components/drawing/DrawingViewer';
import type { DrawingDocument as AnswerDrawingDocument } from '../../components/drawing/types';
import type { DrawingDocument } from '../../components/drawing/types';
import {
  buildGradingQueue,
  countAwaitingGrades,
  type GradeQuestion,
  type GradeTarget,
} from './gradingQueue';
import { playerLabels } from '../../utils/playerDisplayLabel';
import { useMayUseMotionLab } from '../../motion-lab/motionLabAccess';
import nb from '../../styles/notebook.module.css';
import styles from './GradeResponsesPage.module.css';
import { SourcePlayLink } from '../../components/football/SourcePlayLink';

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
 *
 * GRADE FAST (connected-system cycle). One answer is always "current" (gold
 * outline): C marks it correct, X incorrect, and the cursor moves on to the
 * next answer still waiting - so a whole team's drawings are C, C, X, C...
 * with eyes on the drawings, not the mouse. Arrows (or J/K) move, A lays the
 * answer over every drawing or takes it off, U shows only what is still
 * waiting, N goes to the next question. A decision shows at once (the write
 * follows; a failed one is undone and said). The question's progress reads
 * "7 of 11 graded". There is deliberately no "mark all correct": every
 * answer gets a look.
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
  /** DRAWINGS: the coach's answer laid over every player's drawing, or off -
   *  one switch for the whole question rather than one per drawing. */
  const [answerShown, setAnswerShown] = useState(true);
  /** The answer the keys act on, by answer id. */
  const [cursor, setCursor] = useState<number | null>(null);
  /** UNGRADED ONLY: the answers that were still waiting when it was switched
   *  on (or the question opened) - one decided now stays on screen, marked,
   *  until the coach moves on, so a misclick is still visible. */
  const [ungradedOnly, setUngradedOnly] = useState(false);
  const [kept, setKept] = useState<ReadonlySet<number>>(new Set());
  /** Where the source play opens, for a coach who has Motion Lab. */
  const motionLab = useMayUseMotionLab();
  const header = useRef<HTMLElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  /** The cursor moved by key: bring it into view (a click is already in view). */
  const scrollToCursor = useRef(false);
  /** ALL CAUGHT UP HERE: the next quiz still waiting on the coach, if any. */
  const [nextQuiz, setNextQuiz] = useState<ToGrade | null>(null);

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

  /** One answer's decision, here, before the server has it (undone if it refuses). */
  const setDecision = (answerId: number, isCorrect: boolean | null) =>
    setResponses((list) =>
      list.map((r) =>
        r.answers?.some((a) => a.id === answerId)
          ? { ...r, answers: r.answers.map((a) => (a.id === answerId ? { ...a, is_correct: isCorrect } : a)) }
          : r,
      ),
    );

  const visible = useMemo<GradeTarget[]>(
    () =>
      !current ? [] : ungradedOnly ? current.targets.filter((t) => kept.has(t.answerId) || t.isCorrect === null) : current.targets,
    [current, ungradedOnly, kept],
  );

  /** A new question: the cursor on its first answer still waiting. */
  const questionId = current?.questionId;
  useEffect(() => {
    if (!current) return;
    const waiting = current.targets.filter((t) => t.isCorrect === null);
    setCursor(waiting[0]?.answerId ?? current.targets[0]?.answerId ?? null);
    setKept(new Set(waiting.map((t) => t.answerId)));
    // Only when the question changes - not on every decision inside it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId]);

  useEffect(() => {
    if (!scrollToCursor.current || cursor === null) return;
    scrollToCursor.current = false;
    const el = document.querySelector(`[data-answer="${cursor}"]`);
    if (!el) return;
    // Below the sticky question, not under it.
    const box = el.getBoundingClientRect();
    const top = (header.current?.getBoundingClientRect().bottom ?? 0) + 12;
    if (box.top < top || box.bottom > window.innerHeight) window.scrollBy?.({ top: box.top - top, behavior: 'smooth' });
  }, [cursor]);

  /** After a decision: on to the next answer still waiting, else to "Next question". */
  const advanceFrom = (answerId: number, byKey: boolean) => {
    const at = visible.findIndex((t) => t.answerId === answerId);
    for (let k = 1; k < visible.length; k += 1) {
      const next = visible[(at + k) % visible.length];
      if (next.isCorrect === null && next.answerId !== answerId) {
        scrollToCursor.current = byKey;
        setCursor(next.answerId);
        return;
      }
    }
    if (byKey) nextButton.current?.focus();
  };

  async function grade(target: GradeTarget, isCorrect: boolean, byKey = false) {
    if (saving.has(target.answerId)) return;
    setError(null);
    const before = target.isCorrect;
    setSaving((current) => new Set(current).add(target.answerId));
    setDecision(target.answerId, isCorrect);
    advanceFrom(target.answerId, byKey);
    try {
      // The existing write path, unchanged: one answer, by id. It already
      // takes no quiz, player or question, which is why this screen needed no
      // endpoint of its own. Nothing else on this screen depends on the
      // server's reply, so nothing is reloaded after it.
      await gradeAnswer(target.answerId, { is_correct: isCorrect, coach_feedback: null });
    } catch (err) {
      setDecision(target.answerId, before);
      setError(getErrorMessage(err));
    } finally {
      setSaving((current) => {
        const next = new Set(current);
        next.delete(target.answerId);
        return next;
      });
    }
  }

  const goToQuestion = (i: number) => {
    setIndex(i);
    window.scrollTo({ top: 0 });
  };

  const showUngradedOnly = (on: boolean) => {
    setUngradedOnly(on);
    if (on && current) setKept(new Set(current.targets.filter((t) => t.isCorrect === null).map((t) => t.answerId)));
  };

  /* THE KEYS, read fresh on every press (the handler below is installed once). */
  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKey.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !current || remaining === 0) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
    const at = visible.findIndex((t) => t.answerId === cursor);
    const move = (by: number) => {
      const next = visible[Math.max(0, Math.min(visible.length - 1, (at < 0 ? 0 : at) + by))];
      if (!next) return;
      scrollToCursor.current = true;
      setCursor(next.answerId);
    };
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const target = at >= 0 ? visible[at] : undefined;
    if (key === 'c' && target) void grade(target, true, true);
    else if (key === 'x' && target) void grade(target, false, true);
    else if (key === 'ArrowRight' || key === 'j') move(1);
    else if (key === 'ArrowLeft' || key === 'k') move(-1);
    else if (key === 'a' && current.questionType === 'draw_response') setAnswerShown((on) => !on);
    else if (key === 'u') showUngradedOnly(!ungradedOnly);
    else if (key === 'n' && nextUngradedIndex !== null) goToQuestion(nextUngradedIndex);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const listen = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener('keydown', listen);
    return () => window.removeEventListener('keydown', listen);
  }, []);

  /* Another quiz's grading opens in this same screen: start it at its top. */
  useEffect(() => {
    setIndex(0);
    setNextQuiz(null);
  }, [id]);
  /* Nothing left here: is anything waiting elsewhere? Asked once, when done. */
  const done = !loading && quiz !== null && remaining === 0;
  useEffect(() => {
    if (!done) return;
    let live = true;
    listToGrade()
      .then((list) => {
        if (live) setNextQuiz(list.find((q) => q.quiz_id !== id) ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [done, id]);

  if (loading) return <LoadingState label="Loading responses" />;

  if (error && quiz === null) {
    return (
      <div>
        <ErrorBanner message={error} />
        <Link to={`/quizzes/${id}?tab=results`} className={nb.btnSecondary}>
          Back to the quiz
        </Link>
      </div>
    );
  }

  const backToResults = (
    <Link to={`/quizzes/${id}?tab=results`} className={styles.back}>
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
          {/* ON TO THE NEXT ONE without going back to Home to find it. */}
          {nextQuiz && (
            <Link to={`/quizzes/${nextQuiz.quiz_id}/grade`} className={nb.btnPrimary}>
              Next: {nextQuiz.title} · {nextQuiz.count} to grade &rarr;
            </Link>
          )}
          <Link to={`/quizzes/${id}?tab=results`} className={nextQuiz ? nb.btnSecondary : nb.btnPrimary}>
            Back to results
          </Link>
        </div>
      </div>
    );
  }

  if (!current) return null;

  const currentQuestion = quiz?.questions?.find((q) => q.id === current.questionId);
  const isDrawingQuestion = current.questionType === 'draw_response';
  const answerDrawing = currentQuestion?.answer_drawing ?? null;
  const graded = current.targets.length - current.ungradedCount;
  /* WHAT THE QUESTION IS ABOUT, beside it: the concept, who he is, and the
     play it came from - the context a coach grades against. */
  const concept = currentQuestion?.concept?.name ?? null;
  const role = currentQuestion?.subject_role ?? null;
  const sourcePlay = motionLab ? (currentQuestion?.motion_play_id ?? null) : null;

  return (
    <div className={styles.page}>
      {backToResults}
      <ErrorBanner message={error} />

      {/* THE QUESTION ANCHORS THE SCREEN. Stated once, largest thing here,
          with the accepted answers under it as the standard being applied -
          because the coach is holding one standard and applying it to
          everything below. */}
      <header className={styles.header} ref={header}>
        {/* A DRAWING QUESTION'S STANDARD IS A DRAWING. The coach's answer,
            once, in the same green it is laid over every player's drawing in -
            and the one switch for all of them. */}
        {isDrawingQuestion &&
          (answerDrawing && currentQuestion?.image ? (
            <div className={styles.answerKey}>
              <span className={styles.acceptedLabel}>The answer</span>
              <DrawingViewer
                imageUrl={resolveMediaUrl(currentQuestion.image.image_url)}
                document={{ ...answerDrawing, strokes: [] }}
                overlay={answerDrawing}
                maxWidth={220}
                alt={`The answer, drawn, for: ${current.questionText}`}
              />
              <button
                type="button"
                className={styles.keyToggle}
                aria-pressed={answerShown}
                onClick={() => setAnswerShown((on) => !on)}
              >
                <span className={styles.keySwatch} aria-hidden="true" />
                Answer over each drawing: {answerShown ? 'on' : 'off'}
              </button>
            </div>
          ) : (
            <p className={styles.accepted}>
              No answer drawn for this question yet. Draw it in the question editor and it is laid over every
              player&rsquo;s drawing here.
            </p>
          ))}
        <p className={styles.progress}>
          Question {current.questionNumber}
          {' · '}
          {graded} of {current.targets.length} graded
          {' · '}
          {remaining} left on this quiz
        </p>
        <h1 className={styles.question}>{current.questionText}</h1>
        {(concept || role || sourcePlay !== null) && (
          <p className={styles.context}>
            {concept && (
              <span>
                <span className={styles.acceptedLabel}>Concept</span>
                {concept}
              </span>
            )}
            {role && (
              <span>
                <span className={styles.acceptedLabel}>He is</span>
                {role}
              </span>
            )}
            <SourcePlayLink playId={sourcePlay} className={styles.contextLink} />
          </p>
        )}
        {current.expectedAnswers.length > 0 && (
          <p className={styles.accepted}>
            <span className={styles.acceptedLabel}>Accepted</span>
            {current.expectedAnswers.join(' · ')}
          </p>
        )}
        <div className={styles.tools}>
          {/* Only worth offering once something here is decided. */}
          {(graded > 0 || ungradedOnly) && current.ungradedCount > 0 && (
            <button
              type="button"
              className={styles.keyToggle}
              aria-pressed={ungradedOnly}
              onClick={() => showUngradedOnly(!ungradedOnly)}
            >
              Ungraded only: {ungradedOnly ? 'on' : 'off'}
            </button>
          )}
          <span className={styles.keys} aria-hidden="true">
            <kbd>C</kbd> correct · <kbd>X</kbd> incorrect · <kbd>←</kbd>
            <kbd>→</kbd> move{isDrawingQuestion ? ' · ' : ''}
            {isDrawingQuestion && (
              <>
                <kbd>A</kbd> answer on/off
              </>
            )}
            {nextUngradedIndex !== null && (
              <>
                {' · '}
                <kbd>N</kbd> next question
              </>
            )}
          </span>
        </div>
      </header>

      {/* Drawings are judged by eye, side by side: a grid of them. */}
      <ol className={`${styles.responses} ${isDrawingQuestion ? styles.drawingGrid : ''}`}>
        {/* The answers to ONE question are the list a coach reads together,
            so that is where two John Smiths collide. Attempt mode. */}
        {/* Labelled over EVERY answer, then filtered, so a name reads the
            same with "Ungraded only" on or off. */}
        {playerLabels(
          current.targets,
          (t) => ({
            name: t.playerName,
            jerseyNumber: t.jerseyNumber,
            identity: t.playerId ?? `name:${t.playerName}`,
          }),
          'attempt',
        )
          .map((label, i) => ({ target: current.targets[i], label }))
          .filter(({ target }) => visible.includes(target))
          .map(({ target, label }) => (
            <GradeRow
              key={target.answerId}
              target={target}
              playerLabel={label.text}
              questionType={current.questionType}
              questionText={current.questionText}
              answerDrawing={answerDrawing}
              answerShown={answerShown}
              busy={saving.has(target.answerId)}
              current={cursor === target.answerId}
              onPick={() => setCursor(target.answerId)}
              onGrade={(isCorrect) => void grade(target, isCorrect)}
            />
          ))}
      </ol>

      <div className={styles.foot}>
        {nextUngradedIndex !== null ? (
          <button type="button" ref={nextButton} className={nb.btnPrimary} onClick={() => goToQuestion(nextUngradedIndex)}>
            Next question &rarr;
          </button>
        ) : (
          <Link to={`/quizzes/${id}?tab=results`} className={nb.btnPrimary}>
            Back to results
          </Link>
        )}
      </div>
    </div>
  );
}

/** A drawing tile's picture width: three side by side on a laptop (the grid's
 *  column minimum in GradeResponsesPage.module.css is this plus the padding). */
const TILE_DRAWING_WIDTH = 360;

/** One player's answer, and the call.
 *
 * A graded row STAYS, marked. Removing it the instant it is decided would make
 * a misclick invisible at exactly the moment it is most likely - the coach is
 * moving fast and looking at the next answer, not the one they just left.
 */
function GradeRow({
  target,
  playerLabel,
  questionType,
  questionText,
  answerDrawing,
  answerShown = true,
  busy,
  current = false,
  onPick,
  onGrade,
}: {
  target: GradeTarget;
  /** The coach's own drawing of the answer, laid over each player's. */
  answerDrawing?: AnswerDrawingDocument | null;
  /** The question's one switch for showing that answer. */
  answerShown?: boolean;
  /** Display only. The grade is written against `target.answerId`. */
  playerLabel: string;
  questionType: string;
  questionText: string;
  busy: boolean;
  /** The answer the keys act on. */
  current?: boolean;
  /** A click anywhere on it makes it the current one. */
  onPick?: () => void;
  onGrade: (isCorrect: boolean) => void;
}) {
  const isDrawing = questionType === 'draw_response';
  // The image THIS player was delivered, not today's copy of the question, so
  // the strokes sit on the picture they were drawn on.
  const image = target.delivered?.image ?? null;

  return (
    <li
      data-answer={target.answerId}
      aria-current={current ? 'true' : undefined}
      onClick={onPick}
      className={`${styles.row} ${target.isCorrect === true ? styles.rowCorrect : ''} ${
        target.isCorrect === false ? styles.rowIncorrect : ''
      } ${current ? styles.rowCurrent : ''}`}
    >
      <p className={styles.player}>{playerLabel}</p>

      {isDrawing ? (
        target.drawing && image ? (
          <div className={styles.drawing}>
            <CompareDrawing
              imageUrl={resolveMediaUrl(image.image_url)}
              document={target.drawing.document as DrawingDocument}
              answer={answerDrawing}
              shown={answerShown}
              maxWidth={TILE_DRAWING_WIDTH}
              alt={`Drawing by ${playerLabel} for: ${questionText}`}
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
