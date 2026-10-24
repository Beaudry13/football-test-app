import { useState, type ReactNode } from 'react';
import styles from './FootballProblem.module.css';

/**
 * ONE FOOTBALL PROBLEM, said the same way everywhere a coach meets one - a
 * Rep's "What they missed" and a quiz's "Teach next":
 *
 *   MOTION ADJUSTMENT
 *   4 of 11 safeties missed
 *   Most chose "Stay boundary"
 *   [ Teach ] [ Retest ]          View players
 *
 * The problem and the next step are on the card; who missed it, where they
 * tapped and every further action are one tap down (`details`). Presentational
 * only: each screen brings its own Teach and Retest.
 */
export function FootballProblem({
  name,
  label,
  missed,
  responded,
  who = 'players',
  thin = false,
  chose,
  note,
  status,
  fixed = false,
  actions,
  details,
  detailsLabel = 'Who missed it',
  open: openProp,
  onToggle,
  headingLevel = 2,
  children,
}: {
  /** The concept's name - text, or a link to its history. */
  name: ReactNode;
  /** The card's accessible name (the concept's name as text). */
  label: string;
  missed: number;
  responded: number;
  /** "safeties", "players". */
  who?: string;
  /** Too few answers to be sure yet. */
  thin?: boolean;
  /** What the misses chose most, with its count when the screen knows it. */
  chose?: { text: string; detail?: string } | null;
  /** A caveat the coach should see before acting (answers still to grade). */
  note?: ReactNode;
  /** The next-step line: taught, retest out, did it stick. */
  status?: ReactNode;
  /** Fixed on the retest: the card turns green. */
  fixed?: boolean;
  /** Teach and Retest - the two things to do about it. */
  actions?: ReactNode;
  /** Who missed it and everything deeper, behind one quiet toggle. */
  details?: ReactNode;
  detailsLabel?: string;
  /** Controlled open state (the Rep page opens it from its own button). */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  headingLevel?: 2 | 3;
  /** Confirm panels and errors, under the actions. */
  children?: ReactNode;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const toggle = () => {
    const next = !open;
    if (openProp === undefined) setOpenState(next);
    onToggle?.(next);
  };
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <article className={fixed ? `${styles.problem} ${styles.fixed}` : styles.problem} aria-label={label}>
      <Heading className={styles.name}>{name}</Heading>
      <p className={styles.line}>
        <strong>
          {missed} of {responded}
        </strong>{' '}
        {who} missed
        {thin && <span className={styles.thin}> &mdash; too few answers to be sure yet</span>}
      </p>
      {chose && (
        <p className={styles.chose}>
          Most chose <strong>“{chose.text}”</strong>
          {chose.detail && <span className={styles.quiet}> ({chose.detail})</span>}
        </p>
      )}
      {note}
      {status}
      {(actions || details) && (
        <div className={styles.actions}>
          {actions}
          {details && (
            <button type="button" className={styles.detailsToggle} aria-expanded={open} onClick={toggle}>
              {open ? 'Hide' : detailsLabel}
            </button>
          )}
        </div>
      )}
      {children}
      {open && details && <div className={styles.details}>{details}</div>}
    </article>
  );
}
