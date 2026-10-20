import type { PracticeFeedback, Question } from '../../api/types';
import { PlayPicture } from '../../components/football/PlayPicture';
import { TapHint, YouAre } from '../../components/football/DecisionWords';
import { usableTargets, type TapTarget } from '../../components/football/tapTargets';
import { missedOf, rightAnswerOf, roleOf } from './decisionRules';
import styles from './RepRunner.module.css';

// THE FOOTBALL DECISION, ON THE PLAYER'S SCREEN - one component for a Rep's
// decision, Review Missed, and a normal quiz's practice review: who you are,
// the play (moving to the decision moment, or the still) with the answers in
// it, the question, and the coach's verdict.

/** Who you are, the picture, the question - the whole situation. With
 *  `onTap`, each answer is a man in the picture to tap. */
export function Decision({
  question,
  onTap,
  chosen,
  tone,
  disabled,
  still = false,
  onMotionDone,
  showTaps = false,
  correctIds,
}: {
  question: Question;
  /** A Rep, after the decision is locked: the right answer, lit beside his. */
  correctIds?: number[];
  onTap?: (optionId: number) => void;
  /** Review: the answers in the picture, his marked, nothing to tap. */
  showTaps?: boolean;
  chosen?: number[];
  tone?: 'right' | 'wrong' | null;
  disabled?: boolean;
  /** Show the frozen snap without playing the motion (a review, an answered decision). */
  still?: boolean;
  onMotionDone?: () => void;
}) {
  const role = roleOf(question);
  const targets = tapTargetsOf(question);
  /* HIS TAP AND THE RIGHT ONE, on the picture: green for the right answer,
     red for his when it was not. Only once the coach's answer is known. */
  const marks = correctIds
    ? Object.fromEntries([
        ...(chosen ?? []).filter((id) => !correctIds.includes(id)).map((id) => [id, 'wrong' as const]),
        ...correctIds.map((id) => [id, 'right' as const]),
      ])
    : undefined;
  return (
    <>
      {role && <YouAre role={role} />}
      {/* THE PLAY, MOVING to the decision moment (or the still), with the
          answers in it - the one picture every football question uses. */}
      <PlayPicture
        image={question.image}
        presnap={question.presnap}
        targets={onTap || showTaps ? targets : null}
        options={question.options}
        onTap={onTap}
        chosen={chosen}
        tone={tone}
        marks={marks}
        disabled={disabled}
        still={still}
        onMotionDone={onMotionDone}
        pictureClassName={styles.picture}
        marker={question.subject_marker}
        motionKey={question.id}
      />
      <h1 className={styles.prompt}>{question.question_text}</h1>
      {onTap && targets && <TapHint targets={targets} />}
    </>
  );
}

/** The decision's tap spots, when there is one per answer and a picture to tap. */
function tapTargetsOf(question: Question): TapTarget[] | null {
  return usableTargets(question.tap_targets, question.options.length, !!(question.image || question.presnap));
}

export function Verdict({ feedback, right = [] }: { feedback: PracticeFeedback; right?: string[] }) {
  const word = feedback.is_correct === true ? 'Correct' : feedback.is_correct === false ? 'Not quite' : 'Locked in';
  const tone =
    feedback.is_correct === true ? styles.verdictRight : feedback.is_correct === false ? styles.verdictWrong : '';
  return (
    <div className={`${styles.verdict} ${tone}`}>
      <span className={styles.verdictWord}>
        {feedback.is_correct === true ? '✓ ' : feedback.is_correct === false ? '✕ ' : ''}
        {word}
      </span>
      {/* A Rep teaches: when he missed it, the right answer is said plainly. */}
      {feedback.is_correct === false && right.length > 0 && (
        <p className={styles.rightAnswer}>
          Right answer: <strong>{right.join(', ')}</strong>
        </p>
      )}
      {feedback.answer_explanation && (
        <p className={styles.why}>
          <span className={styles.whyLead}>Coach:</span> {feedback.answer_explanation}
        </p>
      )}
    </div>
  );
}

/** Each missed decision again: the situation, what he chose, the right answer
 *  when a Rep says it, the coach's point - and then a way to try it again. */
export function ReviewMissed({
  decisions,
  feedback,
  chosen,
  at,
  onAt,
  onDone,
  onRunAgain,
  runAgainLabel = 'Run it again',
}: {
  decisions: Question[];
  feedback: Record<number, PracticeFeedback>;
  /** What he picked on each decision (option ids). */
  chosen: Record<number, number[]>;
  at: number;
  onAt: (index: number) => void;
  onDone: () => void;
  /** The next action after the last missed one: run it again. */
  onRunAgain?: () => void;
  /** "Run it again" on a Rep; a practice quiz says "Try again". */
  runAgainLabel?: string;
}) {
  const missed = missedOf(decisions, feedback);
  const position = Math.max(0, missed.indexOf(decisions[at]));
  const question = missed[position];
  const finalActions = (
    <div className={styles.summaryActions}>
      {onRunAgain && (
        <button type="button" className="btn btn-primary" onClick={onRunAgain}>
          {runAgainLabel}
        </button>
      )}
      <button type="button" className={onRunAgain ? 'btn' : 'btn btn-primary'} onClick={onDone}>
        Done
      </button>
    </div>
  );
  if (!question) return finalActions;
  const picked = question.options
    .filter((o) => chosen[question.id]?.includes(o.id))
    .map((o) => o.option_text);
  const next = missed[position + 1];
  const reveal = feedback[question.id]?.correct_option_ids;
  return (
    <div className={styles.rep}>
      <div className={styles.reviewHead}>
        Missed {position + 1} of {missed.length}
      </div>
      {/* HIS TAP, ON THE PICTURE HE TAPPED. On a Rep (teaching) the right
          one is lit beside it; a practice quiz leaves the answer to the
          coach's reason below, as it always has. */}
      <Decision
        question={question}
        still
        showTaps
        chosen={chosen[question.id] ?? []}
        tone="wrong"
        correctIds={reveal}
        disabled
      />
      {picked.length > 0 && (
        <div className={`${styles.choice} ${styles.chosen} ${styles.wrong} ${styles.static}`}>
          You chose: {picked.join(', ')}
        </div>
      )}
      <Verdict feedback={feedback[question.id]} right={rightAnswerOf(question, feedback[question.id])} />
      {next ? (
        <div className={styles.summaryActions}>
          <button type="button" className="btn btn-primary" onClick={() => onAt(decisions.indexOf(next))}>
            Next missed
          </button>
        </div>
      ) : (
        finalActions
      )}
    </div>
  );
}
