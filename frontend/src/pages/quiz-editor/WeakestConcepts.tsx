import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRetest } from '../../api/retests';
import { getErrorMessage } from '../../api/client';
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
export function WeakestConcepts({
  concepts,
  quizId,
}: {
  concepts: ConceptBreakdown[];
  quizId: number;
}) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        {/* THE ACTION, on the one thing a coach is meant to do something
            about. Phase D assembles a draft; it does not send anything. */}
        <div className={styles.actions}>
          <button
            type="button"
            className={nb.btnPrimary}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            Retest these {weakest.players_missed.length}
          </button>
        </div>

        {confirming && (
          /* A CONFIRMATION, NOT A WORKFLOW. It says what Peira is about to
             assemble and stops - no options, no editing here. Everything a
             coach might want to change is one screen away in the editor they
             already know, and putting a second editor in front of it would be
             the thing this whole feature avoids. */
          <div className={styles.confirm} role="dialog" aria-label="Create retest">
            <p className={styles.confirmLine}>
              Peira will build a draft on <strong>{weakest.concept_name}</strong> for{' '}
              <strong>{weakest.players_missed.length}</strong>{' '}
              player{weakest.players_missed.length === 1 ? '' : 's'}, using the questions they
              missed.
            </p>
            <p className={styles.confirmNote}>
              Nothing is sent. It opens in the normal editor so you can change the questions,
              the wording, and who gets it.
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
                    /* Canonical ids where they exist, names where they do not -
                       a free-text join has no Player row, and dropping those
                       players would quietly shrink the retest. */
                    const draft = await createRetest(quizId, {
                      concept_id: weakest.concept_id,
                      player_ids: weakest.players_missed
                        .map((p) => p.player_id)
                        .filter((id): id is number => id !== null),
                      player_names: weakest.players_missed
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
                {isCreating ? 'Building…' : 'Create retest'}
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
