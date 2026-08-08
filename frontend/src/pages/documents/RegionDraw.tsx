import { useCallback, useRef, useState } from 'react';
import styles from './RegionDraw.module.css';

/** A rectangle in normalised 0-1 page coordinates. */
export interface NormalisedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Drag-to-draw over a page image.
 *
 * Everything here is in FRACTIONS OF THE ELEMENT, never pixels. The element's
 * own size is the only thing pixel coordinates are ever divided by, so a
 * rectangle drawn on a 900px-wide layout and one drawn on a 1400px-wide layout
 * produce identical stored values - and both stay correct if the page is later
 * re-rendered at a different resolution. See
 * backend/app/services/document_geometry.py for the contract this satisfies.
 *
 * Pointer events, not mouse events: a coach on an iPad is explicitly supported
 * (design doc §12), and pointer events cover both without a second code path.
 * Phone authoring is NOT a goal - the spike measured 3-8% of diagram-page runs
 * reaching a 44px touch target - so nothing here fights for small screens.
 */
export function RegionDraw({
  children,
  existing,
  onDrawn,
  disabled = false,
}: {
  children: React.ReactNode;
  /** Already-created regions, drawn as static overlays. */
  existing: Array<{ id: number; label: string; rect: NormalisedRect }>;
  onDrawn: (rect: NormalisedRect) => void;
  disabled?: boolean;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<NormalisedRect | null>(null);

  const pointFrom = useCallback((event: React.PointerEvent) => {
    const surface = surfaceRef.current;
    if (!surface) return null;
    const bounds = surface.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    // Clamped, so a drag that leaves the image still produces a rectangle
    // inside the page rather than one the server will reject.
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  }, []);

  function rectBetween(a: { x: number; y: number }, b: { x: number; y: number }): NormalisedRect {
    // Normalised so dragging up or left works exactly as well as down-right -
    // a coach should never have to think about which corner they started from.
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    };
  }

  function handlePointerDown(event: React.PointerEvent) {
    if (disabled || event.button !== 0) return;
    const point = pointFrom(event);
    if (!point) return;
    originRef.current = point;
    setDraft({ ...point, width: 0, height: 0 });
    // Capture, so a drag that runs off the image still delivers its move and
    // up events here rather than being swallowed by whatever is underneath.
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function handlePointerMove(event: React.PointerEvent) {
    const origin = originRef.current;
    if (!origin) return;
    const point = pointFrom(event);
    if (point) setDraft(rectBetween(origin, point));
  }

  function handlePointerUp(event: React.PointerEvent) {
    const origin = originRef.current;
    originRef.current = null;
    if (!origin) return;

    const point = pointFrom(event);
    setDraft(null);
    if (!point) return;

    const rect = rectBetween(origin, point);
    // A click, or a twitch, is not a rectangle. Below this the coach almost
    // certainly meant to click rather than drag, and creating a 3px question
    // they then have to find and delete is worse than doing nothing.
    if (rect.width < 0.005 || rect.height < 0.005) return;
    onDrawn(rect);
  }

  const asStyle = (rect: NormalisedRect) => ({
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  });

  return (
    <div
      ref={surfaceRef}
      className={`${styles.surface} ${disabled ? '' : styles.armed}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {children}
      {existing.map((region) => (
        <div key={region.id} className={styles.existing} style={asStyle(region.rect)}>
          <span className={styles.badge}>{region.label}</span>
        </div>
      ))}
      {draft && <div className={styles.draft} style={asStyle(draft)} />}
    </div>
  );
}
