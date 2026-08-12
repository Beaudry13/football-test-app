/**
 * The stage every Competition screen stands on.
 *
 * Exists so Competition styling stays in one place instead of leaking into
 * ordinary Peira components (M2 adds the game to this stage; it should not
 * have to redesign the product again). Keeping the brand row here also means
 * the room looks like one continuous space as a player moves from the code
 * screen to the picker to the waiting room.
 */

import type { ReactNode } from 'react';

import styles from './Competition.module.css';

interface CompetitionShellProps {
  children: ReactNode;
  /** Renders the LIVE tag. Only pass true when the session really is live. */
  live?: boolean;
  /** Optional right-hand slot in the brand row - a code, a count, a control. */
  aside?: ReactNode;
}

export function CompetitionShell({ children, live = false, aside }: CompetitionShellProps) {
  return (
    <div className={styles.stage}>
      <div className={styles.brandRow}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true" />
          <span>Peira · Competition</span>
        </div>
        {live ? (
          <span className={styles.liveTag}>
            <span className={styles.livePulse} aria-hidden="true" />
            Live
          </span>
        ) : (
          aside
        )}
      </div>
      {children}
    </div>
  );
}

export default CompetitionShell;
