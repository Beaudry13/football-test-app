import type { ConceptBreakdown } from '../../api/types';
import { RetestAction } from './RetestAction';
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
export function WeakestConcepts({
  concepts,
  quizId,
}: {
  concepts: ConceptBreakdown[];
  quizId: number;
}) {
  /* Nothing tagged, or nothing graded yet: render nothing at all and let
     Results be what it was. An empty "Weakest concept" panel would be a
     permanent reminder of a feature rather than an answer - and every quiz
     that predates tagging is in exactly this state. */
  const ranked = concepts.filter((c) => c.player_miss_rate !== null);
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
          {/* PLAYERS, AND IT SAYS SO. This line used to read "12 of 20 missed"
              directly above a list of six names, because the count was answers
              and the list was people. A coach asking what to teach is asking
              who needs teaching, so the headline is stated in the same unit as
              the names underneath it and names that unit out loud. The
              answer-level figures are still on the page, in the per-question
              breakdown where the unit cannot be mistaken.

              The COUNT leads, not the percentage. "6 of 10 players" is a fact a
              coach can act on; "60%" is the same fact needing arithmetic first,
              and reads far more confident than a small sample deserves. */}
          <strong>
            {weakest.players_missed_count} of {weakest.players_responded_count} player
            {weakest.players_responded_count === 1 ? '' : 's'} missed this
          </strong>
          {!weakest.has_enough_responses && (
            <span className={styles.thin}> &mdash; too few answers to be sure yet</span>
          )}
        </p>

        {weakest.top_distractor && (
          <p className={styles.distractor}>
            {/* Deliberately "chose", not "believe" or "have a misconception".
                The data says what they picked; it does not say why.

                "WRONG ANSWERS", not "misses" - this is the one figure on the
                panel that is genuinely about answers rather than people, since
                it describes a distribution across options, so it names its own
                unit instead of borrowing the headline's.

                "All 6" rather than "6 of the 6": when every wrong answer chose
                the same option, "6 of the 6" reads like a ratio while carrying
                none of the information one. */}
            {weakest.top_distractor.count === weakest.top_distractor.of_misses ? (
              <>
                All {weakest.top_distractor.of_misses} wrong answers chose{' '}
              </>
            ) : (
              <>
                {weakest.top_distractor.count} of {weakest.top_distractor.of_misses} wrong
                answers chose{' '}
              </>
            )}
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
        {/* THE ACTION, on the one thing a coach is meant to do something
            about. Peira assembles a draft; it does not send anything.

            OFFERED ONLY WHEN IT CAN SUCCEED. Every question these players
            missed may since have been stopped, and retirement is deliberately
            carried through copying - so the action would have returned a
            predictable 422 on a button Peira had put in front of the coach
            itself. Saying why is more useful than a disabled control. */}
        {weakest.retestable_question_count > 0 ? (
          <RetestAction
            quizId={quizId}
            conceptId={weakest.concept_id}
            conceptName={weakest.concept_name}
            targets={weakest.players_missed}
            retiredCount={weakest.retired_missed_question_count}
          />
        ) : (
          <p className={styles.ungradedNote}>
            Every question they missed here has been stopped, so there is nothing to retest.
          </p>
        )}
      </div>

      {rest.length > 0 && (
        <ul className={styles.others}>
          {rest.map((concept) => (
            <li key={concept.concept_id} className={styles.otherRow}>
              <span className={styles.otherName}>{concept.concept_name}</span>
              <span className={styles.otherCount}>
                {/* Same unit as the headline above. A list where the first row
                    counts players and the rest count answers would be the
                    original confusion, merely spread out. */}
                {concept.players_missed_count} of {concept.players_responded_count} players
                {!concept.has_enough_responses && <span className={styles.thin}> (thin)</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
