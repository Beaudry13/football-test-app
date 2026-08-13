/**
 * The ending: the podium reveal and the final standings.
 *
 * SERVER-PACED, NOT AN ANIMATION
 * -------------------------------
 * Which beat is on screen is `podium.step`, decided by the coach and stored on
 * the session. Nothing here advances itself, so the projector, every phone, a
 * refreshed host and a second tab all show the same place at the same time.
 *
 * AN EMPTY PLACE IS SAID OUT LOUD
 * --------------------------------
 * Standard competition ranking means a place can genuinely have nobody in it -
 * two players tied at the top give 1, 1, 3, and there is no second place. The
 * step still happens and the screen says so, rather than skipping the beat or
 * promoting somebody into a place they did not earn.
 */

import type { Podium, PodiumEntry, Standing } from '../../api/competition';
import { ordinal, rankLabel } from './competitionRank';
import styles from './Competition.module.css';

const PLACE_WORD: Record<number, string> = { 1: '1st place', 2: '2nd place', 3: '3rd place' };

/** Which place a reveal step is about; the card and standings steps are not. */
const STEP_PLACE: Record<number, number> = { 1: 3, 2: 2, 3: 1 };

function PlaceReveal({ place, entries }: { place: number; entries: PodiumEntry[] }) {
  return (
    <div className={styles.podium}>
      {/* The place is TEXT, not just a position on screen - a projector may
          wash out colour and a screen reader has no layout to read. */}
      <div className={styles.podiumPlace}>{PLACE_WORD[place]}</div>

      {entries.length === 0 ? (
        <div className={styles.podiumEmpty}>
          <p className={styles.podiumEmptyLead}>No {ordinal(place).toLowerCase()} place</p>
          <p className={styles.subhead}>
            {place === 2
              ? 'A tie at the top means second place was never awarded.'
              : 'A tie above means this place was never awarded.'}
          </p>
        </div>
      ) : (
        <ul className={styles.podiumNames}>
          {entries.map((entry) => (
            <li key={entry.participant_id} className={styles.podiumEntry}>
              <span className={styles.podiumName}>{entry.display_name}</span>
              <span className={styles.podiumScore}>
                {entry.total_points}
                <span className={styles.podiumScoreLabel}>points</span>
              </span>
              <span className={styles.podiumCorrect}>
                {entry.correct_count}/{entry.scored_rounds} correct
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FinalTable({ rows }: { rows: Standing[] }) {
  return (
    <div className={styles.stageRound}>
      <div className={styles.roundBar}>
        <span className={styles.roundTag}>Final standings</span>
      </div>
      {/* EVERYONE, not a top five. The competition is over, there is no
          suspense left to protect, and somebody who came 19th still played. */}
      <ol className={`${styles.board} ${styles.finalBoard}`}>
        {rows.map((row) => (
          <li key={row.participant_id} className={styles.boardRow}>
            <span className={styles.boardRank}>{row.rank}</span>
            <span className={styles.boardName}>{row.display_name}</span>
            <span className={styles.boardCorrect}>
              {row.correct_count}
              <span className={styles.boardCorrectOf}>/{row.scored_rounds}</span>
            </span>
            <span className={styles.boardPoints}>{row.total_points}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function HostPodium({ podium }: { podium: Podium }) {
  const place = STEP_PLACE[podium.step];

  if (podium.step === 0) {
    return (
      <div className={styles.podium}>
        <div className={styles.podiumComplete}>Competition complete</div>
        <p className={styles.subhead}>Results next.</p>
      </div>
    );
  }

  if (place) {
    return <PlaceReveal place={place} entries={podium.places[String(place)] ?? []} />;
  }

  return <FinalTable rows={podium.final_standings} />;
}

export function PlayerPodium({
  podium,
  result,
}: {
  podium: Podium;
  result: Standing & { best_streak: number; is_winner: boolean };
}) {
  const place = STEP_PLACE[podium.step];
  const mine = place !== undefined && result.rank === place;

  if (podium.step === 0) {
    return (
      <div className={styles.podium}>
        <div className={styles.podiumComplete}>Competition complete</div>
        <p className={styles.waitingDots}>Watch the screen…</p>
      </div>
    );
  }

  if (place) {
    // A phone leans into the moment when it IS the moment, and otherwise
    // stays out of the way so the room is watching the projector.
    return (
      <div className={styles.podium}>
        <div className={styles.podiumPlace}>{PLACE_WORD[place]}</div>
        {mine ? (
          <div className={styles.podiumYou}>You finished {ordinal(place)}</div>
        ) : (
          <ul className={styles.podiumNames}>
            {(podium.places[String(place)] ?? []).map((entry) => (
              <li key={entry.participant_id} className={styles.podiumName}>
                {entry.display_name}
              </li>
            ))}
            {(podium.places[String(place)] ?? []).length === 0 && (
              <li className={styles.subhead}>Not awarded — there was a tie above.</li>
            )}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className={styles.playerRound}>
      <div className={styles.standingCard}>
        <div className={styles.standingLabel}>Your final result</div>
        <div className={styles.standingRank}>
          {rankLabel(result.rank, result.tied ?? 1)}
        </div>
      </div>
      <div className={styles.pointsRow}>
        <div>
          <div className={styles.countValue}>
            {result.correct_count}
            <span className={styles.boardCorrectOf}>/{result.scored_rounds}</span>
          </div>
          <div className={styles.countLabel}>Correct</div>
        </div>
        <div>
          <div className={styles.countValue}>{result.total_points}</div>
          <div className={styles.countLabel}>Points</div>
        </div>
      </div>
      {result.best_streak >= 3 && (
        <div className={styles.streak}>Best streak {result.best_streak}</div>
      )}
    </div>
  );
}
