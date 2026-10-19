import { tapsMen, type TapTarget } from './tapTargets';
import styles from './DecisionWords.module.css';

/**
 * THE WORDS AROUND A FOOTBALL DECISION, said one way on every player screen -
 * a Rep, a quiz, Review missed: who you are, and how to answer when the
 * answers are in the picture. Before this the Rep and the quiz said the same
 * two things in two different looks.
 */

/** "YOU'RE THE / Boundary safety" - who the player is in this play. */
export function YouAre({ role }: { role: string }) {
  return (
    <div className={styles.youAre}>
      <span className={styles.lead}>You&rsquo;re the</span>
      <span className={styles.role}>{role}</span>
    </div>
  );
}

/** "Tap the man in the picture" / "Tap the spot on the field" - said once. */
export function TapHint({ targets }: { targets: TapTarget[] }) {
  return <p className={styles.tapHint}>{tapsMen(targets) ? 'Tap the man in the picture' : 'Tap the spot on the field'}</p>;
}
