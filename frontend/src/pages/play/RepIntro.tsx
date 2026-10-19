import type { Quiz } from '../../api/types';
import styles from './RepIntro.module.css';

/**
 * THE ASSIGNED REP, before the player has said who he is: what it is, whose
 * job it tests, how many snaps. No instructions - tapping his name below
 * starts the first decision.
 */
export function RepIntro({ quiz }: { quiz: Quiz }) {
  const decisions = quiz.questions ?? [];
  const roles = [...new Set(decisions.map((q) => q.subject_role?.trim()).filter((r): r is string => !!r))];
  return (
    <section className={styles.card} aria-label="Your rep">
      {/* A Retest says so: it is the second look at something he missed. */}
      <span className={styles.lead}>{quiz.retest_of ? 'Retest - your second look' : 'Your rep'}</span>
      <span className={styles.title}>{quiz.title}</span>
      <span className={styles.meta}>
        {roles.length === 1 ? `You’re the ${roles[0]} · ` : ''}
        {decisions.length} {decisions.length === 1 ? 'decision' : 'decisions'}
      </span>
    </section>
  );
}
