import { useEffect, useMemo, useRef, useState } from 'react';
import { checkAnswer, saveAnswer, submitQuiz } from '../../api/play';
import { getRepProgress, type RepProgress } from '../../api/reps';
import { getErrorMessage } from '../../api/client';
import type {
  DeliveredPlayerQuestion,
  PracticeFeedback,
  Question,
  Quiz,
  ResumedAnswer,
} from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { applyDeliveredContent } from './deliveredQuestions';
import { orderQuestions } from './questionOrder';
import { isAuthRefusal } from './playerEntry';
import { QuestionInput, type PlayerAnswer } from './QuestionInput';
import { Decision, ReviewMissed, Verdict } from './FootballDecision';
import { missedOf, TAPPABLE } from './decisionRules';
import styles from './RepRunner.module.css';

/**
 * SITUATIONAL REP, AS THE PLAYER LIVES IT: "put me in the play".
 *
 * One decision per screen and nothing else on it: who you are, the picture,
 * the question, the answers. Tapping an answer IS answering - it is saved and
 * judged at once (the practice /check, against the coach's own answer), the
 * verdict and the coach's explanation appear, and Next moves on. No
 * instructions page, no Check button, no menu.
 *
 * At the end: the score, the concepts missed, how quickly he decided, and
 * REVIEW MISSED - each missed decision again, picture and all, with what he
 * chose and why the coach says otherwise. The correct option itself is never
 * shown (the practice rule: a re-run must still be a test).
 *
 * A decision that is not a tap-an-answer type (a coach can add any question to
 * a Rep in the quiz editor) falls back to the ordinary answer input with a
 * "Lock it in" button, so nothing a coach builds is unplayable here.
 */

/** Shown above the picture: "YOU'RE THE" / "Boundary safety". */
interface Taken {
  optionIds: number[];
  ms: number | null;
}

export function RepRunner({
  quiz,
  deliveredQuestions,
  questionOrder,
  accessCodeId,
  playerName,
  playerId,
  initialAnswers,
  initialFeedback,
  attemptToken,
  onAuthRequired,
  onRunAgain,
}: {
  quiz: Quiz;
  deliveredQuestions?: DeliveredPlayerQuestion[];
  questionOrder?: number[];
  accessCodeId: number;
  playerName: string;
  playerId?: number;
  initialAnswers: ResumedAnswer[];
  initialFeedback: PracticeFeedback[];
  attemptToken?: () => string | null;
  onAuthRequired?: (reason: string | undefined, answers: Record<number, PlayerAnswer>) => void;
  onRunAgain: () => void;
}) {
  const decisions = useMemo(
    () => orderQuestions(applyDeliveredContent(quiz.questions ?? [], deliveredQuestions), questionOrder),
    [quiz.questions, deliveredQuestions, questionOrder],
  );
  const [feedback, setFeedback] = useState<Record<number, PracticeFeedback>>(() =>
    Object.fromEntries(initialFeedback.map((f) => [f.question_id, f])),
  );
  const [taken, setTaken] = useState<Record<number, Taken>>(() =>
    Object.fromEntries(
      initialAnswers.map((a) => [
        a.question_id,
        { optionIds: a.selected_option_ids ?? (a.selected_option_id ? [a.selected_option_id] : []), ms: null },
      ]),
    ),
  );
  /** Answers for the fallback input (written, draw...), by question. */
  const [drafts, setDrafts] = useState<Record<number, PlayerAnswer>>({});
  const firstOpen = decisions.findIndex((q) => !feedback[q.id]);
  const [index, setIndex] = useState(firstOpen === -1 ? decisions.length : firstOpen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(firstOpen === -1 && decisions.length > 0);
  const [reviewing, setReviewing] = useState<number | null>(null);
  /** His run before this one, and on a Retest his first try on the original. */
  const [progress, setProgress] = useState<RepProgress | null>(null);
  /** Decisions whose pre-snap motion has played out to the snap. */
  const [motionDone, setMotionDone] = useState<Record<number, boolean>>({});
  const shownAt = useRef(Date.now());
  const authRaised = useRef(false);
  const afterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    shownAt.current = Date.now();
  }, [index]);

  function tokenArgs(): [string] | [] {
    const value = attemptToken?.() ?? null;
    return value ? [value] : [];
  }

  function raiseIfAuth(err: unknown): boolean {
    if (!onAuthRequired || !isAuthRefusal(err)) return false;
    if (!authRaised.current) {
      authRaised.current = true;
      onAuthRequired(err.reason, drafts);
    }
    return true;
  }

  const decision = decisions[index] as Question | undefined;
  const judged = decision ? !!feedback[decision.id] : false;
  /* THE QUESTION WAITS FOR THE SNAP: while the motion plays, no answers. */
  const watching = !!decision?.presnap && !motionDone[decision.id] && !judged;

  // On a phone the verdict lands below the answers: bring it (and Next) into view.
  useEffect(() => {
    if (judged) afterRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  }, [judged, index]);

  /** Answer = save + judge, in one tap. */
  async function lockIn(question: Question, answer: PlayerAnswer) {
    if (busy || feedback[question.id]) return;
    const ms = Math.max(0, Date.now() - shownAt.current);
    const optionIds = answer.selected_option_ids ?? (answer.selected_option_id ? [answer.selected_option_id] : []);
    setTaken((t) => ({ ...t, [question.id]: { optionIds, ms } }));
    setBusy(true);
    setError(null);
    try {
      await saveAnswer(
        {
          access_code_id: accessCodeId,
          player_name: playerName,
          player_id: playerId,
          question_id: question.id,
          selected_option_id: answer.selected_option_id ?? null,
          selected_option_ids: answer.selected_option_ids ?? null,
          answer_text: answer.answer_text ?? null,
          time_to_answer_ms: ms,
        },
        ...tokenArgs(),
      );
      const result = await checkAnswer(
        { access_code_id: accessCodeId, player_name: playerName, player_id: playerId, question_id: question.id },
        ...tokenArgs(),
      );
      setFeedback((f) => ({ ...f, [question.id]: result }));
    } catch (err) {
      if (raiseIfAuth(err)) return;
      // Let him try the tap again.
      setTaken((t) => {
        const next = { ...t };
        delete next[question.id];
        return next;
      });
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await submitQuiz(
        {
          access_code_id: accessCodeId,
          player_name: playerName,
          player_id: playerId,
          answers: decisions.map((q) => ({
            question_id: q.id,
            selected_option_id: taken[q.id]?.optionIds.length === 1 ? taken[q.id].optionIds[0] : (drafts[q.id]?.selected_option_id ?? null),
            selected_option_ids: taken[q.id]?.optionIds.length ? taken[q.id].optionIds : (drafts[q.id]?.selected_option_ids ?? null),
            answer_text: drafts[q.id]?.answer_text ?? null,
            drawing: drafts[q.id]?.drawing ?? null,
          })),
        },
        ...tokenArgs(),
      );
    } catch (err) {
      if (raiseIfAuth(err)) return;
      // Every decision is already saved and judged; a failed close-out costs
      // nothing he did, so he still sees how he did.
    } finally {
      setBusy(false);
      setFinished(true);
    }
    // Where he stands against last time - a bonus, never a blocker.
    getRepProgress({ access_code_id: accessCodeId, player_name: playerName, player_id: playerId }, ...tokenArgs())
      .then(setProgress)
      .catch(() => undefined);
  }

  if (finished || !decision) {
    if (reviewing !== null) {
      return (
        <ReviewMissed
          decisions={decisions}
          feedback={feedback}
          chosen={Object.fromEntries(Object.entries(taken).map(([id, t]) => [id, t.optionIds]))}
          at={reviewing}
          onAt={setReviewing}
          onDone={() => setReviewing(null)}
        />
      );
    }
    return (
      <Summary
        decisions={decisions}
        feedback={feedback}
        taken={taken}
        progress={progress}
        onReview={(first) => setReviewing(first)}
        onRunAgain={onRunAgain}
      />
    );
  }

  const verdict = feedback[decision.id];
  const last = index === decisions.length - 1;
  const tappable = TAPPABLE.has(decision.question_type) && !decision.allows_multiple_answers;

  return (
    <div className={styles.rep}>
      <Progress total={decisions.length} at={index} feedback={feedback} decisions={decisions} />
      <Decision
        question={decision}
        onTap={tappable && !watching ? (optionId) => void lockIn(decision, { selected_option_id: optionId }) : undefined}
        chosen={taken[decision.id]?.optionIds}
        tone={verdict ? (verdict.is_correct ? 'right' : verdict.is_correct === false ? 'wrong' : null) : null}
        disabled={busy || !!verdict}
        still={judged}
        onMotionDone={() => {
          // The decision clock starts at the snap, not while he watches.
          shownAt.current = Date.now();
          setMotionDone((m) => ({ ...m, [decision.id]: true }));
        }}
      />
      {watching && <p className={styles.watching}>Watch the motion…</p>}

      {watching ? null : tappable ? (
        <div className={styles.choices} role="group" aria-label="Your answer">
          {decision.options.map((option) => {
            const chosen = taken[decision.id]?.optionIds.includes(option.id);
            const tone = chosen && verdict ? (verdict.is_correct ? styles.right : styles.wrong) : '';
            return (
              <button
                key={option.id}
                type="button"
                className={`${styles.choice} ${chosen ? styles.chosen : ''} ${tone}`}
                disabled={busy || !!verdict}
                aria-pressed={chosen}
                onClick={() => void lockIn(decision, { selected_option_id: option.id })}
              >
                {option.option_text}
              </button>
            );
          })}
        </div>
      ) : (
        <div className={styles.fallback}>
          <QuestionInput
            question={{ ...decision, question_text: '' }}
            index={index}
            answer={drafts[decision.id]}
            onChange={(a) => setDrafts((d) => ({ ...d, [decision.id]: a }))}
            locked={!!verdict}
          />
          {!verdict && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !drafts[decision.id]}
              onClick={() => void lockIn(decision, drafts[decision.id])}
            >
              Lock it in
            </button>
          )}
        </div>
      )}

      <ErrorBanner message={error} />

      {verdict && (
        <div ref={afterRef} className={styles.after} aria-live="polite">
          <Verdict feedback={verdict} />
          <button
            type="button"
            className={`btn btn-primary ${styles.next}`}
            disabled={busy}
            onClick={() => (last ? void finish() : setIndex(index + 1))}
            autoFocus
          >
            {last ? 'Finish' : 'Next'}
          </button>
        </div>
      )}
    </div>
  );
}

function Progress({
  total,
  at,
  feedback,
  decisions,
}: {
  total: number;
  at: number;
  feedback: Record<number, PracticeFeedback>;
  decisions: Question[];
}) {
  return (
    <div className={styles.progress} aria-label={`Decision ${at + 1} of ${total}`}>
      {decisions.map((q, i) => {
        const f = feedback[q.id];
        const tone = f ? (f.is_correct === false ? styles.dotWrong : f.is_correct ? styles.dotRight : styles.dotDone) : '';
        return <span key={q.id} className={`${styles.dot} ${i === at ? styles.dotNow : ''} ${tone}`} />;
      })}
    </div>
  );
}

function Summary({
  decisions,
  feedback,
  taken,
  progress,
  onReview,
  onRunAgain,
}: {
  decisions: Question[];
  feedback: Record<number, PracticeFeedback>;
  taken: Record<number, Taken>;
  progress: RepProgress | null;
  onReview: (first: number) => void;
  onRunAgain: () => void;
}) {
  const judged = decisions.filter((q) => typeof feedback[q.id]?.is_correct === 'boolean');
  const right = judged.filter((q) => feedback[q.id]?.is_correct).length;
  const missed = missedOf(decisions, feedback);
  const concepts = [...new Set(missed.map((q) => q.concept?.name).filter((n): n is string => !!n))];
  /* GOT IT: a concept every one of whose decisions he got right this run. */
  const mastered = [
    ...new Set(judged.map((q) => q.concept?.name).filter((n): n is string => !!n && !concepts.includes(n))),
  ];
  const fixedSinceOriginal = progress?.original
    ? progress.original.missed_concepts.filter((c) => mastered.includes(c))
    : [];
  const stillSinceOriginal = progress?.original
    ? progress.original.missed_concepts.filter((c) => concepts.includes(c))
    : [];
  const times = decisions.map((q) => taken[q.id]?.ms).filter((ms): ms is number => typeof ms === 'number' && ms > 0);
  const average = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
  return (
    <div className={styles.rep}>
      <div className={styles.summary}>
        <span className={styles.summaryLead}>Rep done</span>
        <span className={styles.score}>
          {right} of {judged.length}
        </span>
        {average !== null && (
          <span className={styles.speed}>{(average / 1000).toFixed(1)} s per decision</span>
        )}
        {mastered.length > 0 && (
          <div className={styles.missedConcepts} aria-label="You've got">
            <span className={styles.gotLead}>You&rsquo;ve got</span>
            {mastered.map((c) => (
              <span key={c} className={`${styles.conceptChip} ${styles.gotChip}`}>
                ✓ {c}
              </span>
            ))}
          </div>
        )}
        {concepts.length > 0 && (
          <div className={styles.missedConcepts} aria-label="Work on">
            <span className={styles.missedLead}>Work on</span>
            {concepts.map((c) => (
              <span key={c} className={styles.conceptChip}>
                {c}
              </span>
            ))}
          </div>
        )}
        {missed.length === 0 && judged.length > 0 && <p className={styles.clean}>You knew your job on every snap.</p>}
        {/* AGAINST LAST TIME: his run before this one, and on a Retest the original. */}
        {progress?.previous && (
          <p className={styles.progressLine}>
            Last run {progress.previous.correct} of {progress.previous.answered} → now {right} of {judged.length}
          </p>
        )}
        {fixedSinceOriginal.length > 0 && (
          <p className={`${styles.progressLine} ${styles.progressUp}`}>
            You missed {fixedSinceOriginal.join(', ')} the first time. Now you&rsquo;ve got it.
          </p>
        )}
        {stillSinceOriginal.length > 0 && (
          <p className={styles.progressLine}>
            Still working on {stillSinceOriginal.join(', ')} from the first time.
          </p>
        )}
      </div>
      <div className={styles.summaryActions}>
        {missed.length > 0 && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onReview(decisions.indexOf(missed[0]))}
          >
            Review missed
          </button>
        )}
        <button type="button" className={missed.length > 0 ? 'btn' : 'btn btn-primary'} onClick={onRunAgain}>
          Run it again
        </button>
      </div>
    </div>
  );
}
