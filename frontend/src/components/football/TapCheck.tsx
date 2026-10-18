import { useState } from 'react';
import type { PresnapClip } from '../../motion-lab/presnap';
import { PlayPicture } from './PlayPicture';
import type { TapTarget } from './tapTargets';
import styles from './TapCheck.module.css';

/**
 * WHAT YOUR PLAYERS TAP - the coach's check before a decision goes out, on
 * the very picture and layer the player gets (PlayPicture + TapOverlay):
 *
 *   Move spots  drag a place (a gap, a drop, any spot) to where he means it,
 *               and rename it; a man's ring stays on the man
 *   Try it      tap anything, see which answer it gives - and whether that
 *               is the right one
 *   Looks right the spots are his: confirmed, nothing inferred
 *
 * `onMove` absent = the spots are locked (players already have them).
 */
export function TapCheck({
  image,
  presnap,
  drawn,
  targets,
  answers,
  rightIndex,
  onMove,
  onRename,
  onConfirm,
  onClose,
  lead,
  locked,
  marker,
}: {
  image?: { image_url: string } | null;
  presnap?: PresnapClip | Record<string, unknown> | null;
  /** The picture drawn here (Make rep, before there is an uploaded still). */
  drawn?: { width: number; height: number; draw: (ctx: CanvasRenderingContext2D) => void };
  targets: TapTarget[];
  answers: string[];
  rightIndex: number;
  onMove?: (index: number, at: { x: number; y: number }) => void;
  onRename?: (index: number, text: string) => void;
  onConfirm: () => void;
  onClose: () => void;
  /** A line above the picture ("Check the spots before you make it"). */
  lead?: string;
  /** Why the spots cannot move (players have them). */
  locked?: string;
  /** The coach's "you are this player" ring, as the player will see it. */
  marker?: { x: number; y: number; r: number } | null;
}) {
  const places = targets.map((t, i) => (t.zone ? i : -1)).filter((i) => i >= 0);
  const canMove = !!onMove && places.length > 0;
  const [mode, setMode] = useState<'move' | 'try'>(canMove ? 'move' : 'try');
  const [tried, setTried] = useState<number | null>(null);
  const options = answers.map((option_text, id) => ({ id, option_text }));

  return (
    <div className={styles.backdrop} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className={styles.panel} role="dialog" aria-label="What your players tap" aria-modal="true">
        <div className={styles.top}>
          <h2 className={styles.title}>What your players tap</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {lead && <p className={styles.lead}>{lead}</p>}
        {canMove && (
          <div className={styles.modes} role="radiogroup" aria-label="Check">
            {(['move', 'try'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? `${styles.mode} ${styles.modeOn}` : styles.mode}
                onClick={() => {
                  setMode(m);
                  setTried(null);
                }}
              >
                {m === 'move' ? 'Move spots' : 'Try it'}
              </button>
            ))}
          </div>
        )}
        <PlayPicture
          image={image}
          presnap={presnap}
          drawn={drawn}
          marker={marker}
          still
          targets={targets}
          options={options}
          chosen={tried !== null ? [tried] : []}
          tone={tried === null ? null : tried === rightIndex ? 'right' : 'wrong'}
          onTap={mode === 'try' ? setTried : undefined}
          onMove={mode === 'move' && canMove ? onMove : undefined}
          disabled={mode === 'move' && !canMove}
        />
        <p className={styles.say} role="status">
          {mode === 'move'
            ? 'Drag a spot to where you mean it. A man’s ring stays on the man.'
            : tried === null
              ? 'Tap anything a player could tap.'
              : `That answers “${answers[tried]}” - ${tried === rightIndex ? 'the right one.' : 'not the right one.'}`}
        </p>
        {locked && <p className={styles.locked}>{locked}</p>}
        {canMove && onRename && mode === 'move' && (
          <div className={styles.labels}>
            {places.map((i) => (
              <label key={i} className={styles.label}>
                <span>Spot {i + 1}</span>
                <input value={answers[i]} maxLength={500} onChange={(e) => onRename(i, e.target.value)} aria-label={`Name of spot ${i + 1}`} />
              </label>
            ))}
          </div>
        )}
        <div className={styles.actions}>
          <button type="button" className={styles.confirm} onClick={onConfirm}>
            Looks right
          </button>
        </div>
      </div>
    </div>
  );
}
