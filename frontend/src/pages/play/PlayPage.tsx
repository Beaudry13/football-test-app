import { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { PlayerResponse, ValidateCodeResponse } from '../../api/types';
import { JoinStep } from './JoinStep';
import { NameStep } from './NameStep';
import { QuizStep } from './QuizStep';
import { SubmittedStep } from './SubmittedStep';
import styles from './PlayPage.module.css';

type Step =
  | { name: 'join' }
  | { name: 'name'; joined: ValidateCodeResponse }
  | { name: 'quiz'; joined: ValidateCodeResponse; playerName: string }
  | { name: 'submitted'; response: PlayerResponse };

export function PlayPage() {
  const { code } = useParams<{ code?: string }>();
  const [step, setStep] = useState<Step>({ name: 'join' });

  return (
    <div className={styles.wrapper}>
      {step.name === 'join' && (
        <JoinStep initialCode={code ?? ''} onJoined={(joined) => setStep({ name: 'name', joined })} />
      )}
      {step.name === 'name' && (
        <NameStep
          quizTitle={step.joined.quiz.title}
          rosterPlayers={step.joined.roster_players}
          onSelected={(playerName) => setStep({ name: 'quiz', joined: step.joined, playerName })}
        />
      )}
      {step.name === 'quiz' && (
        <QuizStep
          quiz={step.joined.quiz}
          accessCodeId={step.joined.access_code_id}
          playerName={step.playerName}
          onSubmitted={(response) => setStep({ name: 'submitted', response })}
        />
      )}
      {step.name === 'submitted' && <SubmittedStep response={step.response} />}
    </div>
  );
}
