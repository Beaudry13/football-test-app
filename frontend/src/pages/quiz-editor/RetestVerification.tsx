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
          {/* WHICH CHECK THIS IS ACTUALLY COMPARED AGAINST.
              This said "First check", and on a retest of a retest that was
              simply false: the comparison has always been against the
              IMMEDIATE PARENT, so round 3 was reporting round 2's figures
              under the original round's name. Naming the parent quiz makes
              the claim checkable - a coach can open it - and stays true however
              many rounds deep the chain goes.

              PLAYERS, AND IT SAYS SO - the same unit as every count below, so
              the only thing separating the two populations is this label
              rather than a silent change of denominator. */}
          <span className={styles.contextLabel}>Last check</span>
          <span className={styles.contextDetail}>
            {v.parent_quiz_title} &mdash; <strong>{v.parent_missed_total}</strong> of{' '}
            <strong>{v.parent_response_total}</strong> players missed this
          </span>
        </p>
        <p className={styles.targeted}>
          {/* RECONCILES THE TWO FIGURES when they differ. A coach can retest a
              SUBSET of the players who missed - "14 of 14 players missed this"
              above "went to the 6 players who missed it" read like an
              arithmetic error, when in fact the coach chose six. Saying "6 of
              those 14" accounts for the other eight instead of leaving them
              hanging. */}
          {v.targeted_total < v.parent_missed_total ? (
            <>
              This retest went to <strong>{v.targeted_total}</strong> of those{' '}
              <strong>{v.parent_missed_total}</strong>.
            </>
          ) : (
            <>
              This retest went to the <strong>{v.targeted_total}</strong>{' '}
              player{v.targeted_total === 1 ? '' : 's'} who missed it.
            </>
          )}
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
          {/* NEITHER PENDING STATE IS LISTED HERE, and both are still named.
              They live in the "what is still missing" line below, which states
              them WITH the denominator - "5 of 6 haven't answered yet". Listing
              them here as well printed the same fact twice in consecutive
              lines. All four states remain distinct and separately counted;
              what changed is that the two outcomes appear beside each other and
              the two kinds of outstanding work appear together. Nothing is ever
              folded into the missed count.

              Safe by construction: is_complete is false whenever either count
              is non-zero, so the line below always renders when there is
              something to say. */}
        </ul>

        {!v.is_complete && (
          /* NO IMPROVEMENT STATEMENT WHILE THE EVIDENCE IS INCOMPLETE. A
             number that moves once grading finishes was never a finding, and
             saying so now would be a claim the data cannot yet support.

             AND IT NAMES WHAT IS MISSING. "This is not the full picture yet"
             was true but vague: it told a coach the data was incomplete
             without saying what would complete it, or whether that was their
             job. "5 of 6 haven't answered yet" is the same length and says who
             to chase; "1 is waiting on grading" says the remaining work is the
             coach's own. Both are named when both are true, and neither is
             ever folded into the missed count. */
          <p className={styles.incomplete}>
            {v.not_submitted_count > 0 && (
              <>
                <strong>{v.not_submitted_count}</strong> of{' '}
                <strong>{v.targeted_total}</strong>{' '}
                {v.not_submitted_count === 1 ? 'hasn' : 'haven'}&rsquo;t answered yet
              </>
            )}
            {v.not_submitted_count > 0 && v.ungraded_count > 0 && <>, and </>}
            {v.ungraded_count > 0 && (
              <>
                <strong>{v.ungraded_count}</strong>{' '}
                {v.ungraded_count === 1 ? 'is' : 'are'} waiting on grading
              </>
            )}
            .
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
