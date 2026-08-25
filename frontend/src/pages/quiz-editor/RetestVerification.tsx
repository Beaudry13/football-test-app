import type { RetestVerification as Verification } from '../../api/types';
import nb from '../../styles/notebook.module.css';
import { RetestAction } from './RetestAction';
import styles from './RetestVerification.module.css';

/** Did the result improve?
 *
 * NOT "did they learn it". Every word here is chosen so the card cannot be
 * read as a claim about knowledge: a player who answered correctly this time
 * "answered correctly this time", and that is the whole statement. One correct
 * answer on a copied question is a second observation, not proof - and the
 * coach is the one qualified to decide what it means.
 *
 * THE TWO ROUNDS HAD DIFFERENT POPULATIONS, and the layout says so rather than
 * relying on the reader to notice. The first check went to everyone; the
 * retest went to the players who missed. So the team figure is presented as
 * context in its own line, never as a denominator beside the retest result,
 * and no percentage is shown for either - "4 of 6" is a fact, "67%" invites a
 * comparison with a number computed over a different group.
 */
export function RetestVerification({
  verification,
  quizId,
}: {
  verification: Verification | null;
  /** THIS retest's id. Another round is built FROM the round that exposed the
   *  players still missing, so the lineage keeps describing what was actually
   *  compared: round 3 against round 2, never against the original. */
  quizId?: number;
}) {
  if (!verification) return null;
  const v = verification;

  return (
    <section className={styles.wrap} aria-labelledby="verification">
      <h2 className={styles.eyebrow} id="verification">
        Since the last check
      </h2>

      <div className={`${nb.card} ${styles.card}`}>
        {/* CONTEXT, ON ITS OWN LINE. How big the original problem was - not a
            denominator for anything below it. */}
        <p className={styles.context}>
          {/* PLAYERS, AND IT SAYS SO - the same unit as every count below, so
              the only thing separating the two populations is the label
              "First check" rather than a silent change of denominator. */}
          First check &mdash; <strong>{v.parent_missed_total}</strong> of{' '}
          <strong>{v.parent_response_total}</strong> players missed this
        </p>
        <p className={styles.targeted}>
          This retest went to the <strong>{v.targeted_total}</strong>{' '}
          player{v.targeted_total === 1 ? '' : 's'} who missed it.
        </p>

        <ul className={styles.outcomes}>
          {v.correct_count > 0 && (
            <li className={styles.improved}>
              <strong>{v.correct_count}</strong> player{v.correct_count === 1 ? '' : 's'}{' '}
              answered correctly this time
            </li>
          )}
          {v.incorrect_count > 0 && (
            <li className={styles.remaining}>
              <strong>{v.incorrect_count}</strong> player{v.incorrect_count === 1 ? '' : 's'}{' '}
              still missed
            </li>
          )}
          {/* NEITHER OF THESE IS A MISS, and both are named rather than folded
              into one. An ungraded answer is the coach's backlog; a player who
              has not sat it has not failed it. */}
          {v.ungraded_count > 0 && (
            <li className={styles.pending}>
              {/* PLAYERS. This said "N answers still need grading" while
                  counting PLAYERS whose round is ungraded - a unit error in the
                  one card whose whole purpose is keeping populations straight. */}
              <strong>{v.ungraded_count}</strong> player{v.ungraded_count === 1 ? '' : 's'}{' '}
              {v.ungraded_count === 1 ? 'is' : 'are'} waiting on grading
            </li>
          )}
          {v.not_submitted_count > 0 && (
            <li className={styles.pending}>
              <strong>{v.not_submitted_count}</strong> player
              {v.not_submitted_count === 1 ? ' has' : 's have'} not submitted yet
            </li>
          )}
        </ul>

        {!v.is_complete && (
          /* NO IMPROVEMENT STATEMENT WHILE THE EVIDENCE IS INCOMPLETE. A
             number that moves once grading finishes was never a finding, and
             saying so now would be a claim the data cannot yet support. */
          <p className={styles.incomplete}>
            Still waiting on some answers &mdash; this is not the full picture yet.
          </p>
        )}

        {v.concept_source === 'live_fallback' && (
          /* The delivery predates concept tagging, so the question's current
             tag stood in. Said out loud rather than passed off as history. */
          <p className={styles.caveat}>
            Matched on the question&rsquo;s current concept &mdash; this round was sent before
            concepts were recorded with each answer.
          </p>
        )}

        {v.still_missing.length > 0 && (
          <div className={styles.missing}>
            <div className={styles.missingLabel}>Still missing</div>
            <ul className={styles.playerList}>
              {v.still_missing.map((player) => (
                <li key={player.display_name} className={styles.player}>
                  {player.display_name}
                </li>
              ))}
            </ul>
            {/* ANOTHER ROUND, FROM THE CARD THAT FOUND THE PROBLEM.
                This used to be guarded on a callback that production never
                passed, so the button existed in the bundle and rendered
                nowhere; the only working path was the duplicate weakness panel
                below it. Offered only when the round tested exactly one
                concept - "retest this concept" has no single answer otherwise,
                and guessing one would build the wrong quiz. */}
            {quizId !== undefined &&
              v.concept_ids.length === 1 &&
              v.concept_names.length === 1 && (
                <RetestAction
                  quizId={quizId}
                  conceptId={v.concept_ids[0]}
                  conceptName={v.concept_names[0]}
                  targets={v.still_missing}
                />
              )}
          </div>
        )}
      </div>
    </section>
  );
}
