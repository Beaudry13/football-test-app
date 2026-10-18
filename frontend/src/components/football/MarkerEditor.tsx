import { useRef, useState, type PointerEvent } from 'react';
import { PlayPicture } from './PlayPicture';
import type { Marker } from './tapTargets';
import styles from './TapCheck.module.css';
import own from './MarkerEditor.module.css';

/**
 * "YOU ARE THIS PLAYER" - the coach rings the man on his photo himself: tap
 * him and the gold ring lands there, drag it to adjust, make it smaller or
 * bigger, say who he is. Nothing is read from the photo. The same gold ring
 * a Motion Lab picture puts on the tested man.
 */
export function MarkerEditor({
  imageUrl,
  marker,
  role,
  onDone,
  onClose,
}: {
  imageUrl: string;
  marker: Marker | null;
  role: string;
  onDone: (marker: Marker | null, role: string) => void;
  onClose: () => void;
}) {
  const [ring, setRing] = useState<Marker | null>(marker);
  const [words, setWords] = useState(role);
  const surface = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const at = (e: PointerEvent<HTMLDivElement>) => {
    const box = surface.current?.getBoundingClientRect();
    if (!box?.width || !box.height) return null;
    const clamp = (v: number) => Math.min(0.99, Math.max(0.01, v));
    return { x: clamp((e.clientX - box.left) / box.width), y: clamp((e.clientY - box.top) / box.height) };
  };

  return (
    <div className={styles.backdrop} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className={styles.panel} role="dialog" aria-label="Mark the player" aria-modal="true">
        <div className={styles.top}>
          <h2 className={styles.title}>You are this player</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className={styles.say} role="status">
          {ring ? 'Drag the ring onto him, or tap him again.' : 'Tap the player your players are.'}
        </p>
        <div className={own.frame}>
          <PlayPicture image={{ image_url: imageUrl }} marker={ring} />
          <div
            ref={surface}
            className={own.surface}
            data-marker-surface
            aria-label="Tap the player"
            role="button"
            onPointerDown={(e) => {
              const p = at(e);
              if (!p) return;
              dragging.current = true;
              e.currentTarget.setPointerCapture?.(e.pointerId);
              setRing((r) => ({ x: p.x, y: p.y, r: r?.r ?? 0.05 }));
            }}
            onPointerMove={(e) => {
              if (!dragging.current) return;
              const p = at(e);
              if (p) setRing((r) => ({ x: p.x, y: p.y, r: r?.r ?? 0.05 }));
            }}
            onPointerUp={() => {
              dragging.current = false;
            }}
          />
        </div>
        <div className={own.row}>
          <button
            type="button"
            className={styles.mode}
            disabled={!ring}
            onClick={() => setRing((r) => r && { ...r, r: Math.max(0.02, +(r.r - 0.01).toFixed(3)) })}
          >
            Smaller
          </button>
          <button
            type="button"
            className={styles.mode}
            disabled={!ring}
            onClick={() => setRing((r) => r && { ...r, r: Math.min(0.2, +(r.r + 0.01).toFixed(3)) })}
          >
            Bigger
          </button>
          <label className={styles.label}>
            <span>You&rsquo;re the</span>
            <input value={words} maxLength={60} placeholder="Mike" onChange={(e) => setWords(e.target.value)} aria-label="Who he is" />
          </label>
        </div>
        <div className={styles.actions}>
          {marker && (
            <button type="button" className={styles.mode} onClick={() => onDone(null, words)}>
              Remove the ring
            </button>
          )}
          <button type="button" className={styles.confirm} disabled={!ring} onClick={() => onDone(ring, words)}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
