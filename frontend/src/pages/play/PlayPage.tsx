import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getQuizTitleByCode } from '../../api/play';
import type { ResumedAnswer, ValidateCodeResponse } from '../../api/types';
import { PeiraLogo } from '../../components/brand/PeiraLogo';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { JoinStep } from './JoinStep';
import { NameStep } from './NameStep';
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
      initialAnswers: ResumedAnswer[];
    }
  | { name: 'submitted'; code: string; playerName: string };

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

  const quizTitle = step.name === 'name' || step.name === 'quiz' ? step.joined.quiz.title : prefetchedTitle;
  useDocumentTitle(quizTitle ? `${quizTitle} | Peira` : undefined);

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
          rosterPlayers={step.joined.roster_players}
          accessCodeId={step.joined.access_code_id}
          onStarted={(playerName, attempt) =>
            setStep({
              name: 'quiz',
              code: step.code,
              joined: step.joined,
              playerName,
              initialAnswers: attempt.answers,
            })
          }
          onAlreadySubmitted={(playerName) => setStep({ name: 'submitted', code: step.code, playerName })}
        />
      )}
      {step.name === 'quiz' && (
        <QuizStep
          quiz={step.joined.quiz}
          accessCodeId={step.joined.access_code_id}
          playerName={step.playerName}
          initialAnswers={step.initialAnswers}
          onSubmitted={() => setStep({ name: 'submitted', code: step.code, playerName: step.playerName })}
        />
      )}
      {step.name === 'submitted' && <SubmittedStep code={step.code} playerName={step.playerName} />}
    </div>
  );
}
