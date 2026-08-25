import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRetest } from '../../api/retests';
import { getErrorMessage } from '../../api/client';
import type { RetestTarget } from '../../api/types';
import nb from '../../styles/notebook.module.css';
import styles from './WeakestConcepts.module.css';

/** "Retest these N", and the sentence that confirms what it will build.
 *
 * ONE PLACE ASSEMBLES A RETEST IN THE UI, for the same reason one service
 * assembles it on the server. Two surfaces now offer this action - the weakness
 * panel on an ordinary quiz, and the verification card on a retest that still
 * has players missing - and a coach must be able to predict the outcome
 * identically from either. A second copy of this flow would be one edit away
 * from confirming different things in different places.
 *
 * PEIRA ASSEMBLES; THE COACH SENDS. This creates a draft and navigates to the
 * ordinary editor. It does not activate, does not generate a code, and does not
 * notify anyone.
 */
export function RetestAction({
  quizId,
  conceptId,
  conceptName,
  targets,
  retiredCount = 0,
  buttonLabel,
}: {
  quizId: number;
  conceptId: number;
  conceptName: string | null;
  targets: RetestTarget[];
  /** Missed questions a retest cannot copy because the coach stopped sending
   *  them. Named before the coach commits, never discovered afterwards. */
  retiredCount?: number;
  buttonLabel?: string;
}) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (targets.length === 0) return null;

  const plural = targets.length === 1 ? '' : 's';

  return (
    <>
      <div className={styles.actions}>
        <button
          type="button"
          className={nb.btnPrimary}
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          {/* "Retest these 1" is the sort of phrase only a loop produces. */}
          {buttonLabel ??
            (targets.length === 1 ? 'Retest this player' : `Retest these ${targets.length}`)}
        </button>
      </div>

      {confirming && (
        /* A CONFIRMATION, NOT A WORKFLOW. It says what Peira is about to
           assemble and stops - no options, no editing here. Everything a coach
           might want to change is one screen away in the editor they already
           know, and putting a second editor in front of it would be the thing
           this whole feature avoids. */
        <div className={styles.confirm} role="dialog" aria-label="Create retest">
          <p className={styles.confirmLine}>
            Peira will build a draft on <strong>{conceptName}</strong> for{' '}
            <strong>{targets.length}</strong> player{plural}, using the questions they missed.
          </p>
          {/* SAID BEFORE THEY COMMIT, not after. The server already reported
              what it left out and the client simply never rendered it, so a
              coach got a quietly shorter retest with no way to know. */}
          {retiredCount > 0 && (
            <p className={styles.confirmNote}>
              {retiredCount} stopped question{retiredCount === 1 ? " isn't" : "s aren't"} included.
            </p>
          )}
          <p className={styles.confirmNote}>
            Nothing is sent. It opens in the normal editor so you can change the questions, the
            wording, and who gets it.
          </p>
          {error && (
            <p className={styles.confirmError} role="alert">
              {error}
            </p>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className={nb.btnPrimary}
              disabled={isCreating}
              onClick={async () => {
                setIsCreating(true);
                setError(null);
                try {
                  /* Canonical ids where they exist, names where they do not - a
                     free-text join has no Player row, and dropping those
                     players would quietly shrink the retest. The two lists are
                     disjoint by construction: a canonical player is reachable
                     only by id, and a free-text one only by name. */
                  const draft = await createRetest(quizId, {
                    concept_id: conceptId,
                    player_ids: targets
                      .map((p) => p.player_id)
                      .filter((id): id is number => id !== null),
                    player_names: targets
                      .filter((p) => p.player_id === null)
                      .map((p) => p.player_name),
                  });
                  navigate(`/quizzes/${draft.id}?tab=questions`);
                } catch (err) {
                  setError(getErrorMessage(err));
                  setIsCreating(false);
                }
              }}
            >
              {isCreating ? 'Creating…' : 'Create retest'}
            </button>
            <button
              type="button"
              className={nb.btnSecondary}
              disabled={isCreating}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
