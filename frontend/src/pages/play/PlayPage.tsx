import { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { ResumedAnswer, ValidateCodeResponse } from '../../api/types';
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

  return (
    <div className={styles.wrapper}>
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
