import type { ConceptBreakdown } from '../../api/types';
import nb from '../../styles/notebook.module.css';
import styles from './WeakestConcepts.module.css';

/** "What should I teach next?", above everything else on Results.
 *
 * Results has always opened with a team average and a table of scores - which
 * answers "how did they do", a question the coach can already feel by
 * Wednesday. What they cannot get anywhere is which IDEA the team is weakest
 * on, who specifically missed it, and what those players thought instead.
 *
 * EVERY NUMBER HERE IS HEDGED BY THE DATA THAT PRODUCED IT. A concept two
 * players answered is labelled as thin rather than announced as a weakness,
 * and a wrong-answer pattern is only named when enough players chose the same
 * wrong thing. The thresholds are the server's (see services/concept_results);
 * this file owns only the wording, so a coach reading "60% missed this" is
 * never being told something the sample cannot support.
 */
export function WeakestConcepts({ concepts }: { concepts: ConceptBreakdown[] }) {
  /* Nothing tagged, or nothing graded yet: render nothing at all and let
     Results be what it was. An empty "Weakest concept" panel would be a
     permanent reminder of a feature rather than an answer - and every quiz
     that predates tagging is in exactly this state. */
  const ranked = concepts.filter((c) => c.miss_rate !== null);
  if (ranked.length === 0) return null;

  const [weakest, ...rest] = ranked;

  return (
    <section className={styles.wrap} aria-labelledby="teach-next">
      <h2 className={styles.eyebrow} id="teach-next">
        Teach next
      </h2>

      <div className={`${nb.card} ${styles.headline}`}>
        <div className={styles.conceptName}>{weakest.concept_name}</div>
        <p className={styles.missLine}>
          {/* The COUNT leads, not the percentage. "6 of 22 missed" is a fact a
              coach can act on; "27.3%" is the same fact needing arithmetic
              first, and reads far more confident than a small sample deserves. */}
          <strong>
            {weakest.incorrect_count} of {weakest.graded_count} missed
          </strong>
          {!weakest.has_enough_responses && (
            <span className={styles.thin}> &mdash; too few answers to be sure yet</span>
          )}
        </p>

        {weakest.top_distractor && (
          <p className={styles.distractor}>
            {/* Deliberately "chose", not "believe" or "have a misconception".
                The data says what they picked; it does not say why. */}
            {weakest.top_distractor.count} of the {weakest.top_distractor.of_misses} misses chose{' '}
            <strong>{weakest.top_distractor.option_text}</strong>
          </p>
        )}

        {weakest.players_missed.length > 0 && (
          <div className={styles.players}>
            <div className={styles.playersLabel}>Who missed it</div>
            <ul className={styles.playerList}>
              {weakest.players_missed.map((player) => (
                <li key={player.player_name} className={styles.player}>
                  {player.display_name}
                  {/* Their position WHEN THEY ANSWERED. Absent rather than
                      guessed when it was never recorded. */}
                  {player.position_at_attempt && (
                    <span className={styles.position}>{player.position_at_attempt}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {weakest.ungraded_count > 0 && (
          <p className={styles.ungradedNote}>
            {weakest.ungraded_count} answer{weakest.ungraded_count === 1 ? '' : 's'} here still need
            {weakest.ungraded_count === 1 ? 's' : ''} grading, and {weakest.ungraded_count === 1 ? 'is' : 'are'} not counted
            above.
          </p>
        )}
      </div>

      {rest.length > 0 && (
        <ul className={styles.others}>
          {rest.map((concept) => (
            <li key={concept.concept_id} className={styles.otherRow}>
              <span className={styles.otherName}>{concept.concept_name}</span>
              <span className={styles.otherCount}>
                {concept.incorrect_count} of {concept.graded_count} missed
                {!concept.has_enough_responses && <span className={styles.thin}> (thin)</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
