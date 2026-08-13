/**
 * Standings: the projector's table and a player's own row.
 *
 * THE CLIENT FORMATS; THE SERVER RANKS
 * -------------------------------------
 * Nothing here sorts, ranks, breaks a tie or computes movement. The payload
 * arrives ordered with ranks and movement already decided, and these
 * components render it. Two surfaces re-deriving a ranking is two chances to
 * disagree about who won, in front of the room.
 *
 * The tied group at the cut line is already whole when it arrives - the
 * server returns everyone at or above the fifth rank - so a shared fifth
 * shows as 1,2,3,4,5,5 rather than hiding somebody on a coin flip.
 */

import type { Standing } from '../../api/competition';
import { movementLabel, rankLabel } from './competitionRank';
import styles from './Competition.module.css';

function Movement({ movement }: { movement: number | null | undefined }) {
  const label = movementLabel(movement);
  return (
    <span
      className={`${styles.movement} ${styles[`movement_${label.direction}`]}`}
      // The arrow is a glyph; the meaning is the label. Never colour alone,
      // and never a symbol a screen reader has to guess at.
      aria-label={label.text}
      title={label.text}
    >
      {label.symbol}
    </span>
  );
}

export function HostLeaderboard({ standings }: { standings: Standing[] }) {
  if (standings.length === 0) {
    return <p className={styles.subhead}>No standings yet.</p>;
  }

  return (
    <div className={styles.stageRound}>
      <div className={styles.roundBar}>
        <span className={styles.roundTag}>Standings</span>
        <span className={styles.revealTag}>
          After {standings[0].scored_rounds}{' '}
          {standings[0].scored_rounds === 1 ? 'question' : 'questions'}
        </span>
      </div>

      <ol className={styles.board}>
        {standings.map((row, index) => (
          <li
            key={row.participant_id}
            className={styles.boardRow}
            // Rows settle in sequence, transform/opacity only. Short enough
            // that a coach is not waiting on an animation to talk over.
            style={{ animationDelay: `${Math.min(index, 7) * 70}ms` }}
          >
            <span className={styles.boardRank}>{row.rank}</span>
            <span className={styles.boardName}>{row.display_name}</span>
            <Movement movement={row.movement} />
            {/* The learning number, given real weight - this is a coaching
                product, and points are the speed-sensitive layer on top. */}
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

export function PlayerStanding({ standing }: { standing: Standing }) {
  const label = movementLabel(standing.movement);

  return (
    <div className={styles.playerRound}>
      <div className={styles.standingCard}>
        <div className={styles.standingLabel}>You’re</div>
        {/* T-2ND when the place is shared: telling two level players they
            each hold second alone is a small lie worth not telling. */}
        <div className={styles.standingRank}>
          {rankLabel(standing.rank, standing.tied ?? 1)}
        </div>
        {standing.movement !== null && standing.movement !== undefined ? (
          <div className={`${styles.movement} ${styles[`movement_${label.direction}`]}`}>
            {label.symbol} <span className={styles.movementWord}>{label.text}</span>
          </div>
        ) : (
          <div className={styles.movementNewNote}>New to the board</div>
        )}
      </div>

      <div className={styles.pointsRow}>
        <div>
          <div className={styles.countValue}>
            {standing.correct_count}
            <span className={styles.boardCorrectOf}>/{standing.scored_rounds}</span>
          </div>
          <div className={styles.countLabel}>Correct</div>
        </div>
        <div>
          <div className={styles.countValue}>{standing.total_points}</div>
          <div className={styles.countLabel}>Points</div>
        </div>
      </div>

      {/* Presentation only, from three. Worth no points, and typeset as a
          statistic rather than a reward. */}
      {standing.current_streak >= 3 && (
        <div className={styles.streak}>{standing.current_streak} in a row</div>
      )}
    </div>
  );
}
