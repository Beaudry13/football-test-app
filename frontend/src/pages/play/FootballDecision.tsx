import type { PracticeFeedback, Question } from '../../api/types';
import { PlayPicture } from '../../components/football/PlayPicture';
import { tapsMen, usableTargets, type TapTarget } from '../../components/football/tapTargets';
import { missedOf, roleOf } from './decisionRules';
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
}: {
  question: Question;
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
  return (
    <>
      {role && (
        <div className={styles.role}>
          <span className={styles.roleLead}>You&rsquo;re the</span>
          <span className={styles.roleName}>{role}</span>
        </div>
      )}
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
        disabled={disabled}
        still={still}
        onMotionDone={onMotionDone}
        pictureClassName={styles.picture}
        marker={question.subject_marker}
        motionKey={question.id}
      />
      <h1 className={styles.prompt}>{question.question_text}</h1>
      {onTap && targets && (
        <span className={styles.tapHint}>{tapsMen(targets) ? 'Tap the man in the picture' : 'Tap the spot on the field'}</span>
      )}
    </>
  );
}

/** The decision's tap spots, when there is one per answer and a picture to tap. */
function tapTargetsOf(question: Question): TapTarget[] | null {
  return usableTargets(question.tap_targets, question.options.length, !!(question.image || question.presnap));
}

export function Verdict({ feedback }: { feedback: PracticeFeedback }) {
  const word = feedback.is_correct === true ? 'Correct' : feedback.is_correct === false ? 'Not quite' : 'Locked in';
  const tone =
    feedback.is_correct === true ? styles.verdictRight : feedback.is_correct === false ? styles.verdictWrong : '';
  return (
    <div className={`${styles.verdict} ${tone}`}>
      <span className={styles.verdictWord}>
        {feedback.is_correct === true ? '✓ ' : feedback.is_correct === false ? '✕ ' : ''}
        {word}
      </span>
      {feedback.answer_explanation && (
        <p className={styles.why}>
          <span className={styles.whyLead}>Coach:</span> {feedback.answer_explanation}
        </p>
      )}
    </div>
  );
}

/** Each missed decision again: the situation, what he chose, why the coach says otherwise. */
export function ReviewMissed({
  decisions,
  feedback,
  chosen,
  at,
  onAt,
  onDone,
}: {
  decisions: Question[];
  feedback: Record<number, PracticeFeedback>;
  /** What he picked on each decision (option ids). */
  chosen: Record<number, number[]>;
  at: number;
  onAt: (index: number) => void;
  onDone: () => void;
}) {
  const missed = missedOf(decisions, feedback);
  const position = Math.max(0, missed.indexOf(decisions[at]));
  const question = missed[position];
  if (!question) {
    return (
      <div className={styles.summaryActions}>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    );
  }
  const picked = question.options
    .filter((o) => chosen[question.id]?.includes(o.id))
    .map((o) => o.option_text);
  const next = missed[position + 1];
  return (
    <div className={styles.rep}>
      <div className={styles.reviewHead}>
        Missed {position + 1} of {missed.length}
      </div>
      {/* HIS TAP, ON THE PICTURE HE TAPPED - and only his: the right one is
          the coach's to say, in his reason below (no automatic reveal). */}
      <Decision
        question={question}
        still
        showTaps
        chosen={chosen[question.id] ?? []}
        tone="wrong"
        disabled
      />
      {picked.length > 0 && (
        <div className={`${styles.choice} ${styles.chosen} ${styles.wrong} ${styles.static}`}>
          You chose: {picked.join(', ')}
        </div>
      )}
      <Verdict feedback={feedback[question.id]} />
      <div className={styles.summaryActions}>
        {next ? (
          <button type="button" className="btn btn-primary" onClick={() => onAt(decisions.indexOf(next))}>
            Next missed
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onDone}>
            Done
          </button>
        )}
      </div>
    </div>
  );
}
