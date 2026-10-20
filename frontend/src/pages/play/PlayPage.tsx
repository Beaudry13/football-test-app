import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { getQuizTitleByCode, validateCode } from '../../api/play';
import type {
  AssessmentMode,
  AttemptState,
  DeliveredPlayerQuestion,
  PracticeFeedback,
  ResumedAnswer,
  ValidateCodeResponse,
} from '../../api/types';
import { PeiraLogo } from '../../components/brand/PeiraLogo';
import { LoadingState } from '../../components/ui/LoadingState';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { clearAttemptToken, readAttemptToken } from './attemptToken';
import { JoinStep } from './JoinStep';
import { NameStep } from './NameStep';
import { PinStep } from './PinStep';
import { enterAsPlayer, enterWithPin, pinNoticeFor, type EntryOutcome } from './playerEntry';
import {
  forgetPlayer,
  rememberedPlayer,
  wasActiveInThisTab,
  type RememberedPlayer,
} from './playerSession';
import { PracticeCompleteStep } from './PracticeCompleteStep';
import type { PlayerAnswer } from './QuestionInput';
import { QuizStep, type PracticeReview } from './QuizStep';
import { RepIntro } from './RepIntro';
import { RepRunner } from './RepRunner';
import { HomeReview } from './HomeReview';
import { MyWork } from './MyWork';
import { progressOf, recordDone, recordStarted, reviewFrom, type StoredReview } from './workProgress';
import { SubmittedStep } from './SubmittedStep';
import player from '../../styles/player.module.css';
import styles from './PlayPage.module.css';
import { clearPracticeReview, readPracticeReview, savePracticeReview } from './practiceReviewStore';

/** Work on screen when the server asked the player to prove who they are
 *  mid-quiz, kept so proving it does not cost them what they had not saved. */
interface CarriedWork {
  attemptId: number;
  answers: Record<number, PlayerAnswer>;
}

type Step =
  | { name: 'loading' }
  /** Player Home: what to do next, from the work on this device (/play). */
  | { name: 'home' }
  /** His last run's misses, reviewed from Player Home without a new run. */
  | { name: 'review'; code: string; joined: ValidateCodeResponse; review: StoredReview }
  | { name: 'join' }
  | { name: 'name'; code: string; joined: ValidateCodeResponse; remembered: RememberedPlayer | null }
  | {
      name: 'pin';
      code: string;
      joined: ValidateCodeResponse;
      player: RememberedPlayer & { playerId: number };
      notice: string | null;
      carried: CarriedWork | null;
      run: number;
    }
  | {
      name: 'quiz';
      code: string;
      joined: ValidateCodeResponse;
      player: RememberedPlayer;
      attemptId: number;
      initialAnswers: ResumedAnswer[];
      mode: AssessmentMode;
      /** The attempt's frozen question order. Re-read from the server on every
       *  start/resume rather than remembered, so a refresh cannot drift. */
      questionOrder?: number[];
      /** THE ATTEMPT VERSION INVARIANT. What this attempt was delivered,
       *  re-read from the server on every start/resume. Preferred over
       *  `joined.quiz.questions`, which /validate-code fetched LIVE before the
       *  player picked a name - so after a coach correction those two differ,
       *  and only this one describes the attempt in progress. */
      deliveredQuestions?: DeliveredPlayerQuestion[];
      initialFeedback: PracticeFeedback[];
      carryOverAnswers?: Record<number, PlayerAnswer>;
      /** Bumped on Try Again. Remounts QuizStep so its answers, feedback and
       * lock state all reset - the alternative, resetting each piece from
       * outside, is the kind of partial reset that leaves one stale field
       * behind and makes a retake look like it kept the last one's marks. */
      run: number;
    }
  | { name: 'submitted'; code: string; player: RememberedPlayer }
  | {
      name: 'practice-complete';
      code: string;
      joined: ValidateCodeResponse;
      player: RememberedPlayer;
      feedback: PracticeFeedback[];
      review?: PracticeReview;
      run: number;
    };

/** A roster label for a player the server named (a PIN was required for an id
 *  the player did not pick directly - e.g. a typed name that is a roster player). */
function playerFromRoster(joined: ValidateCodeResponse, playerId: number, fallback: RememberedPlayer): RememberedPlayer {
  const entry = joined.roster_players_v2.find((option) => option.player_id === playerId);
  return entry
    ? { playerId, name: entry.name, jerseyNumber: entry.jersey_number, position: entry.position }
    : { ...fallback, playerId };
}

export function PlayPage() {
  const { code: urlCode } = useParams<{ code?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  /** ?review=1 from Player Home, and this device holds that run's misses. */
  const reviewAsked =
    !!urlCode && new URLSearchParams(location.search).get('review') === '1' && !!progressOf(urlCode)?.review;
  const [step, setStep] = useState<Step>(() =>
    !urlCode ? { name: 'home' } : reviewAsked || rememberedPlayer(urlCode) ? { name: 'loading' } : { name: 'join' },
  );

  /* REVIEW FROM PLAYER HOME: the code's questions, his stored misses. */
  useEffect(() => {
    if (!urlCode || !reviewAsked) return;
    const review = progressOf(urlCode)?.review;
    if (!review) return;
    let cancelled = false;
    validateCode(urlCode)
      .then((joined) => {
        if (!cancelled) setStep({ name: 'review', code: urlCode, joined, review });
      })
      .catch(() => {
        if (!cancelled) setStep({ name: 'join' });
      });
    return () => {
      cancelled = true;
    };
  }, [urlCode, reviewAsked]);
  // Fetched once, up front from the URL's code - before the player has
  // picked a name, `step` itself carries no quiz data yet to set a title
  // from. Once JoinStep's own validateCode resolves (step advances past
  // 'join'), step.joined.quiz.title below is the same value, just from a
  // call that was already happening anyway.
  const [prefetchedTitle, setPrefetchedTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!urlCode) return;
    let cancelled = false;
    getQuizTitleByCode(urlCode)
      .then((res) => {
        if (!cancelled) setPrefetchedTitle(res.quiz_title);
      })
      .catch(() => {
        // Tab title is a nice-to-have, not core flow - leave it generic.
      });
    return () => {
      cancelled = true;
    };
  }, [urlCode]);

  /* A REP LINK GOES STRAIGHT TO THE ASSIGNMENT. A Situational Rep is "tap and
     go": its link skips the code screen (the code is already in it) and lands
     on the assigned rep with the names under it. A quiz link is unchanged - it
     still stops on the code screen. A remembered player is handled below. */
  useEffect(() => {
    if (!urlCode || rememberedPlayer(urlCode)) return;
    let cancelled = false;
    validateCode(urlCode)
      .then((joined) => {
        if (cancelled || joined.quiz.kind !== 'REP') return;
        setStep((current) =>
          current.name === 'join' ? { name: 'name', code: urlCode, joined, remembered: null } : current,
        );
      })
      .catch(() => {
        // The code screen explains an expired or unknown code.
      });
    return () => {
      cancelled = true;
    };
  }, [urlCode]);

  /* A REMEMBERED PLAYER ON THIS CODE. After a refresh in the same tab the quiz
     simply comes back; in a new tab or a reopened browser the player is offered
     "Continue as" first, so a phone passed to a teammate never walks straight
     into somebody else's quiz. */
  //
  // Cancellation, not a run-once flag: React may mount this effect twice (dev
  // StrictMode does), and a flag would let the cancelled first run win and the
  // second never start - leaving the player on "Loading…".
  useEffect(() => {
    if (!urlCode || reviewAsked) return;
    const remembered = rememberedPlayer(urlCode);
    if (!remembered) return;
    let cancelled = false;
    (async () => {
      try {
        const joined = await validateCode(urlCode);
        if (cancelled) return;
        if (wasActiveInThisTab(urlCode)) {
          /* A practice he finished in this tab comes back as he left it -
             Practice complete, with Review missed - not as a fresh run. */
          const finished = readPracticeReview(urlCode, remembered);
          const questions = joined.quiz.questions ?? [];
          if (finished && finished.order.every((id) => questions.some((q) => q.id === id))) {
            setStep({
              name: 'practice-complete',
              code: urlCode,
              joined,
              player: remembered,
              feedback: finished.feedback,
              review: {
                questions: finished.order.map((id) => questions.find((q) => q.id === id)!),
                chosen: finished.chosen,
              },
              run: 0,
            });
            return;
          }
          const outcome = await enterAsPlayer({
            code: urlCode,
            accessCodeId: joined.access_code_id,
            player: remembered,
            continuing: true,
          });
          if (!cancelled) follow(urlCode, joined, remembered, outcome, 0);
          return;
        }
        setStep({ name: 'name', code: urlCode, joined, remembered });
      } catch {
        // Expired, deactivated, or a network hiccup: the code screen says which.
        if (!cancelled) setStep({ name: 'join' });
      }
    })();
    return () => {
      cancelled = true;
    };
    // follow() only calls setStep; this reruns only when the code in the URL changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlCode]);

  const quizTitle =
    step.name === 'name' || step.name === 'quiz' || step.name === 'practice-complete' || step.name === 'pin'
      ? step.joined.quiz.title
      : prefetchedTitle;
  useDocumentTitle(quizTitle ? `${quizTitle} | Peira` : undefined);

  /** Move to wherever the server sent this player. */
  function follow(
    code: string,
    joined: ValidateCodeResponse,
    who: RememberedPlayer,
    outcome: EntryOutcome,
    run: number,
    carried: CarriedWork | null = null,
  ) {
    if (outcome.kind === 'pin') {
      setStep({
        name: 'pin',
        code,
        joined,
        player: { ...playerFromRoster(joined, outcome.playerId, who), playerId: outcome.playerId },
        notice: outcome.notice,
        carried,
        run,
      });
      return;
    }
    if (outcome.kind === 'submitted') {
      recordDone(code, 0);
      setStep({ name: 'submitted', code, player: who });
      return;
    }
    const attempt: AttemptState = outcome.attempt;
    // Only the SAME attempt gets the unsaved work back - never a new practice
    // run that happens to follow it.
    const carryOverAnswers = carried && carried.attemptId === attempt.attempt_id ? carried.answers : undefined;
    // Player Home: this is in progress now (a new run replaces a finished one).
    recordStarted(code);
    setStep({
      name: 'quiz',
      code,
      joined,
      player: who,
      attemptId: attempt.attempt_id,
      initialAnswers: attempt.answers,
      // From the ATTEMPT, not the access code: the attempt froze its mode when
      // it started, and that is what governs it. The same is true of the order
      // - a refresh re-reads it from the server rather than re-deriving or
      // remembering it here.
      mode: attempt.mode,
      questionOrder: attempt.question_order,
      deliveredQuestions: attempt.questions,
      initialFeedback: attempt.feedback,
      carryOverAnswers,
      run,
    });
  }

  function handleJoined(code: string, joined: ValidateCodeResponse) {
    // Keep the code in the address bar, so a refresh comes back to this quiz
    // instead of the empty code box. Not a router navigation: nothing re-renders.
    if (!urlCode && window.location.pathname.replace(/\/$/, '') === '/play') {
      window.history.replaceState(window.history.state, '', `/play/${encodeURIComponent(code.toUpperCase())}`);
    }
    setStep({ name: 'name', code, joined, remembered: rememberedPlayer(code) });
  }

  async function handleTryAgain() {
    if (step.name !== 'practice-complete') return;
    clearPracticeReview(step.code);
    // A new attempt, not a cleared one. Practice retakes are unlimited
    // because the database's uniqueness rule covers graded attempts only,
    // so this simply starts another - the finished one stays as history.
    // Continuing as the same player, so a device holding their token starts
    // the retake without asking for the PIN again.
    try {
      const outcome = await enterAsPlayer({
        code: step.code,
        accessCodeId: step.joined.access_code_id,
        player: step.player,
        continuing: true,
      });
      follow(step.code, step.joined, step.player, outcome, step.run + 1);
    } catch {
      // Back to "Continue as", where a retry shows what went wrong.
      setStep({ name: 'name', code: step.code, joined: step.joined, remembered: step.player });
    }
  }

  /** A Rep's "Run it again": a fresh practice attempt, as Try again starts one. */
  async function handleRunRepAgain() {
    if (step.name !== 'quiz') return;
    try {
      const outcome = await enterAsPlayer({
        code: step.code,
        accessCodeId: step.joined.access_code_id,
        player: step.player,
        continuing: true,
      });
      follow(step.code, step.joined, step.player, outcome, step.run + 1);
    } catch {
      setStep({ name: 'name', code: step.code, joined: step.joined, remembered: step.player });
    }
  }

  function handleAuthRequired(reason: string | undefined, answers: Record<number, PlayerAnswer>) {
    setStep((current) => {
      if (current.name !== 'quiz' || current.player.playerId === null) return current;
      const playerId = current.player.playerId;
      const hadToken = readAttemptToken(current.code, playerId) !== null;
      clearAttemptToken(current.code, playerId);
      return {
        name: 'pin',
        code: current.code,
        joined: current.joined,
        player: { ...current.player, playerId },
        notice: pinNoticeFor(reason, hadToken) ?? 'Enter your PIN to keep going.',
        carried: { attemptId: current.attemptId, answers },
        run: current.run,
      };
    });
  }

  return (
    <div className={`${player.playerTheme} ${styles.wrapper}`}>
      <div className={styles.brandRow}>
        <PeiraLogo variant="light" markOnly size={28} />
      </div>
      {step.name === 'loading' && <LoadingState label="Loading…" />}
      {step.name === 'home' && <MyWork joinSlot={<JoinStep initialCode="" onJoined={handleJoined} />} />}
      {step.name === 'review' && (
        <HomeReview
          questions={step.joined.quiz.questions ?? []}
          review={step.review}
          isRep={step.joined.quiz.kind === 'REP'}
          onDone={() => navigate('/play')}
          onRunAgain={() => {
            // Off ?review, onto the ordinary way in: "Continue as", then a fresh run.
            window.history.replaceState(window.history.state, '', `/play/${encodeURIComponent(step.code)}`);
            setStep({ name: 'name', code: step.code, joined: step.joined, remembered: rememberedPlayer(step.code) });
          }}
        />
      )}
      {step.name === 'join' && <JoinStep initialCode={urlCode ?? ''} onJoined={handleJoined} />}
      {/* SITUATIONAL REP: the assignment first, big - then tap your name and go. */}
      {step.name === 'name' && step.joined.quiz.kind === 'REP' && <RepIntro quiz={step.joined.quiz} />}
      {step.name === 'name' && (
        <NameStep
          quizTitle={step.joined.quiz.kind === 'REP' ? 'Who are you?' : step.joined.quiz.title}
          rosterPlayers={step.joined.roster_players_v2}
          remembered={step.remembered}
          onForgetRemembered={() => {
            forgetPlayer(step.code);
            setStep({ ...step, remembered: null });
          }}
          onChoose={async (who, continuing) => {
            const outcome = await enterAsPlayer({
              code: step.code,
              accessCodeId: step.joined.access_code_id,
              player: who,
              continuing,
            });
            follow(step.code, step.joined, who, outcome, 0);
          }}
        />
      )}
      {step.name === 'pin' && (
        <PinStep
          title={step.joined.quiz.title}
          player={step.player}
          notice={step.notice}
          onSubmitPin={async (pin) => {
            const outcome = await enterWithPin({
              code: step.code,
              accessCodeId: step.joined.access_code_id,
              player: step.player,
              pin,
            });
            follow(step.code, step.joined, step.player, outcome, step.run, step.carried);
          }}
          onNotYou={() => {
            forgetPlayer(step.code);
            setStep({ name: 'name', code: step.code, joined: step.joined, remembered: null });
          }}
        />
      )}
      {step.name === 'quiz' && step.joined.quiz.kind === 'REP' && (
        <RepRunner
          key={`${step.run}:${step.attemptId}`}
          quiz={step.joined.quiz}
          deliveredQuestions={step.deliveredQuestions}
          questionOrder={step.questionOrder}
          accessCodeId={step.joined.access_code_id}
          playerName={step.player.name}
          playerId={step.player.playerId ?? undefined}
          initialAnswers={step.initialAnswers}
          initialFeedback={step.initialFeedback}
          attemptToken={() =>
            step.player.playerId === null ? null : readAttemptToken(step.code, step.player.playerId)
          }
          onAuthRequired={handleAuthRequired}
          onRunAgain={() => void handleRunRepAgain()}
          onFinished={(order, feedback, chosen) => {
            const review = reviewFrom(order, feedback, chosen);
            recordDone(step.code, review.missedIds.length, review);
          }}
        />
      )}
      {step.name === 'quiz' && step.joined.quiz.kind !== 'REP' && (
        <QuizStep
          key={`${step.run}:${step.attemptId}`}
          quiz={step.joined.quiz}
          deliveredQuestions={step.deliveredQuestions}
          accessCodeId={step.joined.access_code_id}
          playerName={step.player.name}
          playerId={step.player.playerId ?? undefined}
          initialAnswers={step.initialAnswers}
          carryOverAnswers={step.carryOverAnswers}
          mode={step.mode}
          questionOrder={step.questionOrder}
          initialFeedback={step.initialFeedback}
          attemptToken={() =>
            step.player.playerId === null ? null : readAttemptToken(step.code, step.player.playerId)
          }
          onAuthRequired={handleAuthRequired}
          onSubmitted={() => {
            recordDone(step.code, 0);
            setStep({ name: 'submitted', code: step.code, player: step.player });
          }}
          onPracticeComplete={(feedback, review) => {
            if (review) {
              savePracticeReview(step.code, step.player, feedback, review.questions.map((q) => q.id), review.chosen);
            }
            const stored = review ? reviewFrom(review.questions.map((q) => q.id), feedback, review.chosen) : undefined;
            recordDone(step.code, feedback.filter((f) => f.is_correct === false).length, stored);
            setStep({
              name: 'practice-complete',
              code: step.code,
              joined: step.joined,
              player: step.player,
              feedback,
              review,
              run: step.run,
            });
          }}
        />
      )}
      {step.name === 'practice-complete' && (
        <PracticeCompleteStep feedback={step.feedback} review={step.review} onTryAgain={() => void handleTryAgain()} />
      )}
      {step.name === 'submitted' && (
        <SubmittedStep
          code={step.code}
          playerName={step.player.name}
          playerId={step.player.playerId ?? undefined}
          player={step.player}
        />
      )}
    </div>
  );
}
