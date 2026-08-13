/**
 * The projector during a round: question, ALL IN, and the reveal.
 *
 * THREE MOMENTS, ONE SCREEN
 * --------------------------
 * 1. Lead-in    - 3-2-1, derived from `question_opened_at` being in the future.
 * 2. Answering  - the question, and a COUNT of how many are in. Never names,
 *                 never the distribution: the room must not be steered by
 *                 seeing what everyone else picked.
 * 3. Held       - the window has shut (clock ran out, or everyone answered
 *                 early). ALL IN / ANSWERS LOCKED, holding energy until the
 *                 coach reveals rather than leaving a dead screen.
 *
 * The reveal is a separate component because it is a different job: it is the
 * teaching surface, and the explanation is its largest element.
 */

import type { CompetitionPollState, HostRound } from '../../api/competition';
import { useCompetitionClock } from './useCompetitionClock';
import styles from './Competition.module.css';

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

/** A question image, sized so it can never push the answers off a screen. */
function QuestionImage({ url, alt }: { url: string; alt: string }) {
  return (
    <div className={styles.questionImageWrap}>
      <img
        className={styles.questionImage}
        src={url}
        alt={alt}
        // A missing or broken image must never take the competition down with
        // it - the question text still stands on its own.
        onError={(event) => {
          event.currentTarget.style.display = 'none';
        }}
      />
    </div>
  );
}

export function HostQuestionStage({
  round,
  poll,
}: {
  round: HostRound;
  /**
   * THE LIVE HALF, straight off the 1 Hz poll.
   *
   * `round` comes from the heavy host view, which is only refetched when the
   * VERSION changes - so anything in it that moves with the clock or with a
   * submission is stale the moment it arrives. Reading `answered_count` or
   * `answering_open` from there froze the projector on ANSWERS LOCKED with
   * 28 seconds still on the clock, which is exactly the sort of thing only a
   * real walkthrough finds.
   *
   * Counters ride the poll; the heavy payload carries the question. That is
   * the M2.1 rule, and this is the component that has to honour it.
   */
  poll: CompetitionPollState | null;
}) {
  const clock = useCompetitionClock(
    poll?.server_now ?? null,
    round.question_opened_at,
    round.question_closes_at,
  );

  if (clock.inLeadIn) {
    return (
      <div className={styles.leadIn}>
        <div className={styles.leadInLabel}>Get ready</div>
        <div className={styles.leadInCount}>{Math.ceil(clock.leadInRemaining)}</div>
        <div className={styles.roundTag}>
          Round {round.round_number} of {round.total_rounds}
        </div>
      </div>
    );
  }

  // The window is shut - either the clock ran out or everyone is already in.
  // Derived from the CLOCK and the POLL, never from the version-gated payload.
  const allIn = poll?.all_in ?? false;
  const answered = poll?.answered_count ?? round.answered_count;
  const total = poll?.participant_count ?? round.participant_count;
  const held = clock.expired || allIn;

  return (
    <div className={styles.stageRound}>
      <div className={styles.roundBar}>
        <span className={styles.roundTag}>
          Round {round.round_number} of {round.total_rounds}
        </span>
        {held ? (
          <span className={styles.lockedTag}>
            {allIn ? 'All in · answers locked' : 'Answers locked'}
          </span>
        ) : (
          <span className={styles.timerTag} aria-live="off">
            {clock.remainingSeconds}s
          </span>
        )}
      </div>

      {!held && (
        <div
          className={styles.timerBar}
          role="progressbar"
          aria-label="Time remaining"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((1 - clock.progress) * 100)}
        >
          <div
            className={styles.timerFill}
            style={{ width: `${(1 - clock.progress) * 100}%` }}
          />
        </div>
      )}

      <h1 className={styles.questionText}>{round.question.question_text}</h1>

      {round.question.image?.image_url && (
        <QuestionImage url={round.question.image.image_url} alt="Question image" />
      )}

      <div className={styles.optionGrid}>
        {round.question.options.map((option, index) => (
          <div key={option.id} className={styles.optionTile}>
            <span className={styles.optionLetter}>{LETTERS[index]}</span>
            <span className={styles.optionText}>{option.option_text}</span>
          </div>
        ))}
      </div>

      <div className={styles.answeredRow}>
        <div className={styles.answeredCount}>
          {answered} <span className={styles.answeredOf}>/ {total}</span>
        </div>
        {/* A COUNT. Never a list of who is still thinking - naming stragglers
            on a wall in front of their team is not something this does. */}
        <div className={styles.countLabel}>Answered</div>
      </div>
    </div>
  );
}

export function HostRevealStage({ round }: { round: HostRound }) {
  const correctId = round.question.correct_option_id;
  const total = (round.distribution ?? []).reduce((sum, row) => sum + row.count, 0);

  return (
    <div className={styles.stageRound}>
      <div className={styles.roundBar}>
        <span className={styles.roundTag}>
          Round {round.round_number} of {round.total_rounds}
        </span>
        <span className={styles.revealTag}>Answer</span>
      </div>

      <h1 className={styles.questionText}>{round.question.question_text}</h1>

      <div className={styles.optionGrid}>
        {round.question.options.map((option, index) => {
          const isCorrect = option.id === correctId;
          const row = (round.distribution ?? []).find((d) => d.option_id === option.id);
          const share = total > 0 ? ((row?.count ?? 0) / total) * 100 : 0;
          return (
            <div
              key={option.id}
              className={`${styles.optionTile} ${isCorrect ? styles.optionCorrect : styles.optionDim}`}
            >
              {/* Correctness carries a letter, a word and a check - never
                  colour alone, which a projector may wash out and a
                  colour-blind viewer may not see at all. */}
              <span className={styles.optionLetter}>{LETTERS[index]}</span>
              <span className={styles.optionText}>{option.option_text}</span>
              <span className={styles.optionCount}>
                {isCorrect && <span className={styles.correctMark}>✓ Correct</span>}
                {row?.count ?? 0}
              </span>
              <div className={styles.optionBar} style={{ width: `${share}%` }} />
            </div>
          );
        })}
      </div>

      {round.question.answer_explanation && (
        /* THE TEACHING MOMENT. Deliberately the largest block on the screen -
           this is the thing that separates a Peira competition from a trivia
           game, and burying it as small print would give that away. */
        <div className={styles.explanation}>
          <div className={styles.explanationLabel}>Why</div>
          <p className={styles.explanationText}>{round.question.answer_explanation}</p>
        </div>
      )}
    </div>
  );
}
