import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getQuizTitleByCode, startAttempt } from '../../api/play';
import type {
  AssessmentMode,
  PracticeFeedback,
  ResumedAnswer,
  ValidateCodeResponse,
} from '../../api/types';
import { PeiraLogo } from '../../components/brand/PeiraLogo';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { JoinStep } from './JoinStep';
import { NameStep } from './NameStep';
import { PracticeCompleteStep } from './PracticeCompleteStep';
import { QuizStep } from './QuizStep';
import { SubmittedStep } from './SubmittedStep';
import styles from './PlayPage.module.css';

type Step =
  | { name: 'join' }
  | { name: 'name'; code: string; joined: ValidateCodeResponse }
  | {
      name: 'quiz';
      code: string;
      joined: ValidateCodeResponse;
      playerName: string;
      playerId: number | undefined;
      initialAnswers: ResumedAnswer[];
      mode: AssessmentMode;
      /** The attempt's frozen question order. Re-read from the server on every
       *  start/resume rather than remembered, so a refresh cannot drift. */
      questionOrder?: number[];
      initialFeedback: PracticeFeedback[];
      /** Bumped on Try Again. Remounts QuizStep so its answers, feedback and
       * lock state all reset - the alternative, resetting each piece from
       * outside, is the kind of partial reset that leaves one stale field
       * behind and makes a retake look like it kept the last one's marks. */
      run: number;
    }
  | { name: 'submitted'; code: string; playerName: string; playerId: number | undefined }
  | {
      name: 'practice-complete';
      code: string;
      joined: ValidateCodeResponse;
      playerName: string;
      playerId: number | undefined;
      feedback: PracticeFeedback[];
      run: number;
    };

export function PlayPage() {
  const { code } = useParams<{ code?: string }>();
  const [step, setStep] = useState<Step>({ name: 'join' });
  // Fetched once, up front from the URL's code - before the player has
  // picked a name, `step` itself carries no quiz data yet to set a title
  // from. Once JoinStep's own validateCode resolves (step advances past
  // 'join'), step.joined.quiz.title below is the same value, just from a
  // call that was already happening anyway.
  const [prefetchedTitle, setPrefetchedTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    getQuizTitleByCode(code)
      .then((res) => {
        if (!cancelled) setPrefetchedTitle(res.quiz_title);
      })
      .catch(() => {
        // Tab title is a nice-to-have, not core flow - leave it generic.
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const quizTitle =
    step.name === 'name' || step.name === 'quiz' || step.name === 'practice-complete'
      ? step.joined.quiz.title
      : prefetchedTitle;
  useDocumentTitle(quizTitle ? `${quizTitle} | Peira` : undefined);

  async function handleTryAgain() {
    if (step.name !== 'practice-complete') return;
    // A new attempt, not a cleared one. Practice retakes are unlimited
    // because the database's uniqueness rule covers graded attempts only,
    // so this simply starts another - the finished one stays as history.
    const attempt = await startAttempt({
      access_code_id: step.joined.access_code_id,
      player_name: step.playerName,
      player_id: step.playerId,
    });
    setStep({
      name: 'quiz',
      code: step.code,
      joined: step.joined,
      playerName: step.playerName,
      playerId: step.playerId,
      initialAnswers: attempt.answers,
      mode: attempt.mode,
      // Try Again created a NEW attempt, so this is a new order - which is
      // exactly the point of randomized practice.
      questionOrder: attempt.question_order,
      initialFeedback: attempt.feedback,
      run: step.run + 1,
    });
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.brandRow}>
        <PeiraLogo variant="light" markOnly size={28} />
      </div>
      {step.name === 'join' && (
        <JoinStep
          initialCode={code ?? ''}
          onJoined={(joinedCode, joined) => setStep({ name: 'name', code: joinedCode, joined })}
        />
      )}
      {step.name === 'name' && (
        <NameStep
          quizTitle={step.joined.quiz.title}
          rosterPlayers={step.joined.roster_players_v2}
          accessCodeId={step.joined.access_code_id}
          onStarted={(playerName, playerId, attempt) =>
            setStep({
              name: 'quiz',
              code: step.code,
              joined: step.joined,
              playerName,
              playerId,
              initialAnswers: attempt.answers,
              // From the ATTEMPT, not the access code: the attempt froze its
              // mode when it started, and that is what governs it. The same
              // is true of the order - a refresh re-reads it from the server
              // rather than re-deriving or remembering it here.
              mode: attempt.mode,
              questionOrder: attempt.question_order,
              initialFeedback: attempt.feedback,
              run: 0,
            })
          }
          onAlreadySubmitted={(playerName, playerId) =>
            setStep({ name: 'submitted', code: step.code, playerName, playerId })
          }
        />
      )}
      {step.name === 'quiz' && (
        <QuizStep
          key={step.run}
          quiz={step.joined.quiz}
          accessCodeId={step.joined.access_code_id}
          playerName={step.playerName}
          playerId={step.playerId}
          initialAnswers={step.initialAnswers}
          mode={step.mode}
          questionOrder={step.questionOrder}
          initialFeedback={step.initialFeedback}
          onSubmitted={() =>
            setStep({ name: 'submitted', code: step.code, playerName: step.playerName, playerId: step.playerId })
          }
          onPracticeComplete={(feedback) =>
            setStep({
              name: 'practice-complete',
              code: step.code,
              joined: step.joined,
              playerName: step.playerName,
              playerId: step.playerId,
              feedback,
              run: step.run,
            })
          }
        />
      )}
      {step.name === 'practice-complete' && (
        <PracticeCompleteStep
          feedback={step.feedback}
          onTryAgain={() => void handleTryAgain()}
        />
      )}
      {step.name === 'submitted' && (
        <SubmittedStep code={step.code} playerName={step.playerName} playerId={step.playerId} />
      )}
    </div>
  );
}
