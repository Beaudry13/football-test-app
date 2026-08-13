/**
 * The player's phone during a round.
 *
 * THE RULE THAT SHAPES THE WHOLE SUBMIT FLOW
 * -------------------------------------------
 * Never show ANSWER LOCKED until the server has said so. An optimistic lock
 * would be a lie in exactly the case that matters most - a tap near the
 * deadline that did not arrive in time. So: tap → SENDING → the server's
 * verdict, and if it was late the screen says so plainly.
 *
 * A failed request while time REMAINS is a different situation from a refused
 * one, and gets a retry rather than a rejection - losing a player's tap to a
 * dropped packet without telling them would be the worst of both.
 */

import { useCallback, useState } from 'react';

import { ApiError } from '../../api/client';
import * as competitionApi from '../../api/competition';
import type { PlayerRound } from '../../api/competition';
import { useCompetitionClock } from './useCompetitionClock';
import styles from './Competition.module.css';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'sending'; optionId: number }
  | { kind: 'retry'; optionId: number }
  | { kind: 'too_late' };

export function PlayerQuestionScreen({
  round,
  joinCode,
  token,
  onAnswered,
}: {
  round: PlayerRound;
  joinCode: string;
  token: string;
  onAnswered: () => void;
}) {
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });
  const clock = useCompetitionClock(
    round.server_now,
    round.question_opened_at,
    round.question_closes_at,
  );

  const choose = useCallback(
    async (optionId: number) => {
      // Guards an accidental double tap without pretending anything succeeded.
      if (submit.kind === 'sending' || round.answered) return;
      setSubmit({ kind: 'sending', optionId });
      try {
        await competitionApi.submitAnswer(joinCode, token, round.round_index, optionId);
        setSubmit({ kind: 'idle' });
        onAnswered();
      } catch (error) {
        if (error instanceof ApiError && error.reason === 'answering_closed') {
          setSubmit({ kind: 'too_late' });
        } else if (error instanceof ApiError && error.reason === 'answer_locked') {
          // Already in - a retry that actually succeeded the first time.
          setSubmit({ kind: 'idle' });
          onAnswered();
        } else if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          setSubmit({ kind: 'too_late' });
        } else {
          // Network. Time may well remain, so offer the tap again rather than
          // silently swallowing it.
          setSubmit({ kind: 'retry', optionId });
        }
      }
    },
    [joinCode, token, round.round_index, round.answered, submit.kind, onAnswered],
  );

  if (clock.inLeadIn) {
    return (
      <div className={styles.leadIn}>
        <div className={styles.leadInLabel}>Get ready</div>
        <div className={styles.leadInCount}>{Math.ceil(clock.leadInRemaining)}</div>
      </div>
    );
  }

  const question = round.question;
  if (!question) return <p className={styles.waitingDots}>Waiting for the next question…</p>;

  const locked = round.answered;
  // Derived from the server timestamps via the clock, NOT from the payload's
  // `answering_open` - that is a snapshot taken when the round was fetched,
  // and a phone holding it would keep offering answers after the deadline (or
  // refuse them before it). The same staleness froze the host stage.
  const timeUp = clock.expired;
  const chosen = round.selected_option_id;

  return (
    <div className={styles.playerRound}>
      <div className={styles.roundBar}>
        <span className={styles.roundTag}>
          {round.round_number} / {round.total_rounds}
        </span>
        {!timeUp && <span className={styles.timerTag}>{clock.remainingSeconds}s</span>}
      </div>

      {!timeUp && (
        <div className={styles.timerBar} role="progressbar" aria-label="Time remaining"
             aria-valuemin={0} aria-valuemax={100}
             aria-valuenow={Math.round((1 - clock.progress) * 100)}>
          <div className={styles.timerFill} style={{ width: `${(1 - clock.progress) * 100}%` }} />
        </div>
      )}

      <p className={styles.playerQuestionText}>{question.question_text}</p>

      {question.image?.image_url && (
        <div className={styles.playerImageWrap}>
          <img
            className={styles.playerImage}
            src={question.image.image_url}
            alt="Question image"
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
        </div>
      )}

      {locked ? (
        <div className={styles.lockedPanel} role="status">
          <div className={styles.lockedLabel}>✓ Answer locked</div>
          <div className={styles.lockedChoice}>
            {LETTERS[question.options.findIndex((o) => o.id === chosen)]} ·{' '}
            {question.options.find((o) => o.id === chosen)?.option_text}
          </div>
          <p className={styles.waitingDots}>Waiting for the answer…</p>
        </div>
      ) : timeUp || submit.kind === 'too_late' ? (
        <div className={`${styles.notice} ${styles.noticeWarn}`} role="status">
          <strong>Time’s up</strong>
          <p style={{ margin: '0.35rem 0 0' }}>
            {submit.kind === 'too_late'
              ? 'Your answer didn’t arrive in time.'
              : 'You didn’t answer this one.'}
          </p>
        </div>
      ) : (
        <div className={styles.answerList}>
          {question.options.map((option, index) => {
            const sending = submit.kind === 'sending' && submit.optionId === option.id;
            const retrying = submit.kind === 'retry' && submit.optionId === option.id;
            return (
              <button
                key={option.id}
                type="button"
                className={styles.answerButton}
                onClick={() => choose(option.id)}
                disabled={submit.kind === 'sending'}
              >
                <span className={styles.answerLetter}>{LETTERS[index]}</span>
                <span className={styles.answerText}>{option.option_text}</span>
                {sending && <span className={styles.answerState}>Sending…</span>}
                {retrying && <span className={styles.answerState}>Tap to retry</span>}
              </button>
            );
          })}
          {submit.kind === 'retry' && (
            <div className={styles.notice} role="alert">
              That didn’t send. You still have time — tap your answer again.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PlayerRevealScreen({ round }: { round: PlayerRound }) {
  const question = round.question;
  const result = round.result;
  if (!question || !result) return null;

  const correctIndex = question.options.findIndex(
    (o) => o.id === question.correct_option_id,
  );
  const correct = question.options[correctIndex];

  // Three outcomes, not two. "You didn't answer" is its own sentence - telling
  // someone they got it wrong when they were never given the chance is a
  // different and worse message.
  const outcome = !result.answered ? 'none' : result.is_correct ? 'correct' : 'wrong';
  const COPY = {
    correct: { mark: '✓', word: 'Correct', className: styles.verdictCorrect },
    wrong: { mark: '✕', word: 'Incorrect', className: styles.verdictWrong },
    none: { mark: '—', word: 'No answer', className: styles.verdictNone },
  }[outcome];

  return (
    <div className={styles.playerRound}>
      {/* Mark AND word AND colour - never colour alone. */}
      <div className={`${styles.verdict} ${COPY.className}`} role="status">
        <span className={styles.verdictMark} aria-hidden="true">{COPY.mark}</span>
        <span className={styles.verdictWord}>{COPY.word}</span>
      </div>

      <div className={styles.revealAnswer}>
        <span className={styles.answerLetter}>{LETTERS[correctIndex]}</span>
        <span className={styles.answerText}>{correct?.option_text}</span>
      </div>

      <div className={styles.pointsRow}>
        <div>
          <div className={styles.countValue}>+{result.points_earned}</div>
          <div className={styles.countLabel}>This round</div>
        </div>
        <div>
          <div className={styles.countValue}>{result.total_points}</div>
          <div className={styles.countLabel}>Total</div>
        </div>
      </div>

      {/* Presentation only, from 3 - worth exactly zero points, and shown as
          type rather than as a cartoon flame. */}
      {result.current_streak >= 3 && (
        <div className={styles.streak}>{result.current_streak} in a row</div>
      )}

      {question.answer_explanation && (
        <div className={styles.explanation}>
          <div className={styles.explanationLabel}>Why</div>
          <p className={styles.explanationText}>{question.answer_explanation}</p>
        </div>
      )}
    </div>
  );
}
