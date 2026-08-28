import { useCallback, useRef, useState } from 'react';
import styles from './RegionDraw.module.css';

/** A rectangle in normalised 0-1 page coordinates. */
export interface NormalisedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExistingRegion {
  id: number;
  label: string;
  rect: NormalisedRect;
}

/** Below this much movement the gesture was a CLICK, not a drag. */
const DRAG_THRESHOLD = 0.005;

/** Corner handles, as fractions of the page. Generous relative to their visual
 *  size, because a coach resizing a mask on a 6pt label is aiming at something
 *  a few pixels across. */
const HANDLE_HIT = 0.008;

type Corner = 'nw' | 'ne' | 'sw' | 'se';
const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se'];

type Gesture =
  | { kind: 'idle' }
  | { kind: 'maybe-draw'; origin: { x: number; y: number } }
  | { kind: 'move'; id: number; grab: { x: number; y: number }; start: NormalisedRect }
  | { kind: 'resize'; id: number; corner: Corner; start: NormalisedRect };

/** The authoring surface: one gesture model for tap, drag, move and resize.
 *
 * THERE IS NO MODE SWITCH, and that is the point. What the coach does decides
 * what happens:
 *
 *   click empty page      -> onClick, and the parent decides whether a text
 *                            run was under it (tap-to-select) or nothing was
 *   drag empty page       -> onDrawn, a hand-drawn rectangle for a diagram
 *   click a region        -> selects it
 *   drag a region         -> moves it
 *   drag a corner handle  -> resizes it
 *
 * A page with an install sheet on the left and a formation on the right needs
 * both behaviours within one second of each other, so asking the coach to
 * pick a tool first would be asking them to keep answering a question they
 * have already answered by aiming.
 *
 * Everything is in FRACTIONS OF THE ELEMENT. The element's own size is the
 * only thing pixels are ever divided by, so the same gesture on a 900px and a
 * 1400px layout produces identical stored values.
 */
export function RegionDraw({
  children,
  existing,
  selectedId,
  onClick,
  onDrawn,
  onRegionChanged,
  onSelect,
  disabled = false,
  pending = null,
}: {
  children: React.ReactNode;
  existing: ExistingRegion[];
  selectedId: number | null;
  /** A rectangle the PARENT is still holding - drawn, but not yet saved as a
   *  question. Purely a marker: this component's own `draft` state lives only
   *  for the duration of the gesture and is cleared on pointerup, so without
   *  this the page shows nothing at all while the coach fills in the form.
   *  Read-only, like `existing` - it is rendered, never edited. */
  pending?: NormalisedRect | null;
  /** A click that was not on an existing region. The parent hit-tests the
   *  text layer; a miss means "nothing there", which is not an error. */
  onClick: (x: number, y: number) => void;
  onDrawn: (rect: NormalisedRect) => void;
  onRegionChanged: (id: number, rect: NormalisedRect) => void;
  onSelect: (id: number | null) => void;
  disabled?: boolean;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture>({ kind: 'idle' });
  const [draft, setDraft] = useState<NormalisedRect | null>(null);
  const [live, setLive] = useState<{ id: number; rect: NormalisedRect } | null>(null);

  const pointFrom = useCallback((event: React.PointerEvent) => {
    const surface = surfaceRef.current;
    if (!surface) return null;
    const bounds = surface.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  }, []);

  function rectBetween(a: { x: number; y: number }, b: { x: number; y: number }): NormalisedRect {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
    };
  }

  function cornerAt(rect: NormalisedRect, x: number, y: number): Corner | null {
    const points: Record<Corner, [number, number]> = {
      nw: [rect.x, rect.y],
      ne: [rect.x + rect.width, rect.y],
      sw: [rect.x, rect.y + rect.height],
      se: [rect.x + rect.width, rect.y + rect.height],
    };
    for (const corner of CORNERS) {
      const [cx, cy] = points[corner];
      if (Math.abs(x - cx) <= HANDLE_HIT && Math.abs(y - cy) <= HANDLE_HIT) return corner;
    }
    return null;
  }

  function regionUnder(x: number, y: number): ExistingRegion | null {
    let best: ExistingRegion | null = null;
    let bestArea = Infinity;
    for (const region of existing) {
      const r = region.rect;
      if (x < r.x || x > r.x + r.width || y < r.y || y > r.y + r.height) continue;
      const area = r.width * r.height;
      if (area < bestArea) {
        best = region;
        bestArea = area;
      }
    }
    return best;
  }

  function clampRect(rect: NormalisedRect): NormalisedRect {
    const width = Math.min(rect.width, 1);
    const height = Math.min(rect.height, 1);
    return {
      x: Math.min(Math.max(0, rect.x), 1 - width),
      y: Math.min(Math.max(0, rect.y), 1 - height),
      width,
      height,
    };
  }

  function handlePointerDown(event: React.PointerEvent) {
    if (disabled || event.button !== 0) return;
    const point = pointFrom(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();

    // Handles first: they sit ON the region's edge, so testing the region
    // before its handles would make resizing impossible.
    const selected = existing.find((r) => r.id === selectedId);
    if (selected) {
      const corner = cornerAt(selected.rect, point.x, point.y);
      if (corner) {
        gesture.current = { kind: 'resize', id: selected.id, corner, start: selected.rect };
        return;
      }
    }

    const under = regionUnder(point.x, point.y);
    if (under) {
      onSelect(under.id);
      gesture.current = { kind: 'move', id: under.id, grab: point, start: under.rect };
      return;
    }

    gesture.current = { kind: 'maybe-draw', origin: point };
  }

  function handlePointerMove(event: React.PointerEvent) {
    const current = gesture.current;
    if (current.kind === 'idle') return;
    const point = pointFrom(event);
    if (!point) return;

    if (current.kind === 'maybe-draw') {
      setDraft(rectBetween(current.origin, point));
      return;
    }

    if (current.kind === 'move') {
      setLive({
        id: current.id,
        rect: clampRect({
          ...current.start,
          x: current.start.x + (point.x - current.grab.x),
          y: current.start.y + (point.y - current.grab.y),
        }),
      });
      return;
    }

    // Resize: the dragged corner follows the pointer, the opposite corner is
    // pinned, so dragging past it flips the rectangle rather than inverting it.
    const s = current.start;
    const anchor = {
      x: current.corner === 'nw' || current.corner === 'sw' ? s.x + s.width : s.x,
      y: current.corner === 'nw' || current.corner === 'ne' ? s.y + s.height : s.y,
    };
    setLive({ id: current.id, rect: clampRect(rectBetween(anchor, point)) });
  }

  function handlePointerUp(event: React.PointerEvent) {
    const current = gesture.current;
    gesture.current = { kind: 'idle' };
    const point = pointFrom(event);
    setDraft(null);
    setLive(null);
    if (current.kind === 'idle' || !point) return;

    if (current.kind === 'maybe-draw') {
      const rect = rectBetween(current.origin, point);
      // Under the threshold this was a CLICK. That is not a failed drag - it
      // is the tap-to-select gesture, and the parent decides what was under it.
      if (rect.width < DRAG_THRESHOLD && rect.height < DRAG_THRESHOLD) {
        onSelect(null);
        onClick(point.x, point.y);
        return;
      }
      onDrawn(rect);
      return;
    }

    if (current.kind === 'move') {
      const moved = clampRect({
        ...current.start,
        x: current.start.x + (point.x - current.grab.x),
        y: current.start.y + (point.y - current.grab.y),
      });
      // A click on a region selects it (already done on pointerdown) without
      // recording a no-op move in the undo history.
      if (
        Math.abs(moved.x - current.start.x) < DRAG_THRESHOLD &&
        Math.abs(moved.y - current.start.y) < DRAG_THRESHOLD
      ) {
        return;
      }
      onRegionChanged(current.id, moved);
      return;
    }

    const s = current.start;
    const anchor = {
      x: current.corner === 'nw' || current.corner === 'sw' ? s.x + s.width : s.x,
      y: current.corner === 'nw' || current.corner === 'ne' ? s.y + s.height : s.y,
    };
    const resized = clampRect(rectBetween(anchor, point));
    if (resized.width < DRAG_THRESHOLD || resized.height < DRAG_THRESHOLD) return;
    onRegionChanged(current.id, resized);
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

      {existing.map((region) => {
        const rect = live?.id === region.id ? live.rect : region.rect;
        const isSelected = region.id === selectedId;
        return (
          <div
            key={region.id}
            className={`${styles.existing} ${isSelected ? styles.existingSelected : ''}`}
            style={asStyle(rect)}
          >
            <span className={styles.badge}>{region.label}</span>
            {isSelected &&
              CORNERS.map((corner) => (
                <span key={corner} className={`${styles.handle} ${styles[corner]}`} />
              ))}
          </div>
        );
      })}

      {/* The live gesture wins: while a drag is in progress the coach is
          looking at the rectangle they are dragging, not the last one. */}
      {draft && <div className={styles.draft} style={asStyle(draft)} />}
      {!draft && pending && (
        <div className={styles.pending} style={asStyle(pending)} aria-hidden="true" />
      )}
    </div>
  );
}
