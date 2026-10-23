import { useNavigate } from 'react-router-dom';
import type { RetestTarget } from '../../api/types';
import { buildQuizRetest, retestLabel } from '../../components/teach/retest';
import { StepButton } from '../../components/ui/StepButton';
import nb from '../../styles/notebook.module.css';
import styles from './WeakestConcepts.module.css';

/** "Retest the 3" on a quiz concept: the weakness panel on an ordinary quiz,
 *  and the verification card on a retest that still has players missing.
 *
 * PEIRA BUILDS; THE COACH SENDS. One tap builds a draft of the questions they
 * missed, for exactly them, and opens it on its Send tab - who gets it, said,
 * and one button. Nothing is sent, so there is nothing to confirm here; what
 * the retest leaves out (stopped questions) is said on the draft itself. The
 * same build every other Retest uses (components/teach/retest.ts).
 */
export function RetestAction({ quizId, conceptId, targets }: { quizId: number; conceptId: number; targets: RetestTarget[] }) {
  const navigate = useNavigate();
  if (targets.length === 0) return null;
  return (
    <div className={styles.actions}>
      <StepButton
        className={nb.btnPrimary}
        label={retestLabel(targets.map((p) => p.display_name ?? p.player_name))}
        run={async () => navigate(await buildQuizRetest(quizId, { concept_id: conceptId }, targets))}
      />
    </div>
  );
}
