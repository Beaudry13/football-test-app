import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  clampScale,
  distance,
  midpoint,
  zoomAroundPoint,
  RESET_STATE,
  DOUBLE_TAP_SCALE,
  type Point,
  type ZoomState,
} from './pinchZoomMath';
import styles from './PinchZoomPan.module.css';

const TAP_MOVE_THRESHOLD_PX = 10;
const DOUBLE_TAP_WINDOW_MS = 300;
const SNAP_TRANSITION_MS = 160;

type Gesture =
  | { mode: 'none' }
  | { mode: 'pan'; pointerId: number; lastX: number; lastY: number }
  | { mode: 'pinch'; pairIds: [number, number]; startDistance: number; startScale: number };

/** Pinch-to-zoom-and-pan wrapper for a single image/canvas child, built with native Pointer
 * Events (no gesture library exists or is installed in this project). Two nested boxes, not
 * one: the outer "surface" holds all pointer listeners and is NEVER itself transformed, so its
 * hit-testing region (and the reset button, its sibling) stays put regardless of how far the
 * inner "content" box has been panned - a single transformed div would drag its own listeners
 * off-screen along with the content, making recovery unreachable exactly when it's needed. */
export function PinchZoomPan({ children }: { children: ReactNode }) {
  const [zoom, setZoom] = useState<ZoomState>(RESET_STATE);
  const [isSnapping, setIsSnapping] = useState(false);
  const zoomRef = useRef(zoom);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef<Map<number, Point>>(new Map());
  const gestureRef = useRef<Gesture>({ mode: 'none' });
  const tapCandidateRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | null>(
    null,
  );
  const lastTapRef = useRef<{ time: number; pos: Point } | null>(null);
  const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(
    () => () => {
      if (snapTimerRef.current) clearTimeout(snapTimerRef.current);
    },
    [],
  );

  function relativeToSurface(point: Point): Point {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return point;
    return { x: point.x - rect.left, y: point.y - rect.top };
  }

  function snapTo(next: ZoomState) {
    setIsSnapping(true);
    setZoom(next);
    if (snapTimerRef.current) clearTimeout(snapTimerRef.current);
    snapTimerRef.current = setTimeout(() => setIsSnapping(false), SNAP_TRANSITION_MS);
  }

  /** Recomputes which pointers are driving the current gesture (and from what baseline)
   * whenever the SET of active pointers changes - a finger landing/lifting, a 3rd finger
   * joining, or a pinch handing off into a single-finger pan. Never adjusts an existing
   * gesture's baseline incrementally; always re-derives it fresh from current live values, so
   * a topology change can't compound into drift or a visible jump. */
  function reanchor() {
    const pts = Array.from(pointersRef.current.entries());
    if (pts.length >= 2) {
      const [[id1, p1], [id2, p2]] = pts.slice(0, 2);
      const prev = gestureRef.current;
      const samePair = prev.mode === 'pinch' && prev.pairIds[0] === id1 && prev.pairIds[1] === id2;
      if (!samePair) {
        gestureRef.current = {
          mode: 'pinch',
          pairIds: [id1, id2],
          startDistance: distance(p1, p2),
          startScale: zoomRef.current.scale,
        };
      }
    } else if (pts.length === 1) {
      const [[id, p]] = pts;
      gestureRef.current =
        zoomRef.current.scale > 1 ? { mode: 'pan', pointerId: id, lastX: p.x, lastY: p.y } : { mode: 'none' };
    } else {
      gestureRef.current = { mode: 'none' };
    }
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    tapCandidateRef.current =
      pointersRef.current.size === 1
        ? { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false }
        : null;
    reanchor();
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    const tap = tapCandidateRef.current;
    if (tap && tap.pointerId === e.pointerId && !tap.moved) {
      if (distance({ x: tap.startX, y: tap.startY }, { x: e.clientX, y: e.clientY }) > TAP_MOVE_THRESHOLD_PX) {
        tap.moved = true;
      }
    }

    const gesture = gestureRef.current;
    if (gesture.mode === 'pinch') {
      const p1 = pointersRef.current.get(gesture.pairIds[0]);
      const p2 = pointersRef.current.get(gesture.pairIds[1]);
      if (!p1 || !p2) return;
      const newScale = clampScale(gesture.startScale * (distance(p1, p2) / gesture.startDistance));
      const focal = relativeToSurface(midpoint(p1, p2));
      setZoom((prev) => zoomAroundPoint(prev, focal, newScale));
    } else if (gesture.mode === 'pan') {
      const p = pointersRef.current.get(gesture.pointerId);
      if (!p) return;
      const dx = p.x - gesture.lastX;
      const dy = p.y - gesture.lastY;
      gestureRef.current = { ...gesture, lastX: p.x, lastY: p.y };
      setZoom((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    }
  }

  function handlePointerUpOrCancel(e: ReactPointerEvent<HTMLDivElement>) {
    const tap = tapCandidateRef.current;
    const wasTap = tap?.pointerId === e.pointerId && !tap.moved && pointersRef.current.size === 1;

    pointersRef.current.delete(e.pointerId);
    tapCandidateRef.current = null;
    reanchor();

    if (!wasTap) return;

    const now = Date.now();
    const pos: Point = { x: e.clientX, y: e.clientY };
    const last = lastTapRef.current;
    if (last && now - last.time < DOUBLE_TAP_WINDOW_MS && distance(last.pos, pos) < TAP_MOVE_THRESHOLD_PX) {
      lastTapRef.current = null;
      toggleZoomAt(pos);
    } else {
      lastTapRef.current = { time: now, pos };
    }
  }

  function toggleZoomAt(clientPos: Point) {
    const focal = relativeToSurface(clientPos);
    snapTo(zoomRef.current.scale > 1 ? RESET_STATE : zoomAroundPoint(zoomRef.current, focal, DOUBLE_TAP_SCALE));
  }

  return (
    <div
      ref={surfaceRef}
      className={styles.surface}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUpOrCancel}
      onPointerCancel={handlePointerUpOrCancel}
      onDoubleClick={(e) => toggleZoomAt({ x: e.clientX, y: e.clientY })}
      // A consumer (ImageLightbox) may put a click-to-close handler on an ancestor - nothing
      // inside this surface (the image/canvas, or the reset button below) should ever bubble a
      // click out to that, regardless of which child was actually clicked.
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className={styles.content}
        style={{
          transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
          transition: isSnapping ? `transform ${SNAP_TRANSITION_MS}ms ease-out` : 'none',
        }}
      >
        {children}
      </div>
      {zoom.scale > 1 && (
        <button type="button" className={styles.resetButton} onClick={() => snapTo(RESET_STATE)}>
          Reset zoom
        </button>
      )}
    </div>
  );
}
