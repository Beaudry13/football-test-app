import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../ui/Icon';
import { DrawingEngine } from './drawingEngine';
import { GestureArbiter, type ArbiterCommand, type DrawingTool, type GestureClass } from './gestureArbiter';
import { resolveRenderScale, type RenderScaleResult } from './renderScale';
import { useScrollLock } from './useScrollLock';
import type { DrawingDocument } from './types';
import styles from './DrawingBoard.module.css';

/** Live numbers for the spike HUD. The engine reports them; the board does
 * not render them itself, so nothing HUD-shaped leaks into production. */
export interface BoardTelemetry {
  fps: number;
  pointerCount: number;
  gesture: GestureClass;
  zoom: number;
  strokeCount: number;
  render: RenderScaleResult;
  viewport: { width: number; height: number };
  orientation: string;
  preventedStrays: number;
  suspectedStrays: number;
}

export interface DrawingBoardProps {
  imageUrl: string;
  document: DrawingDocument;
  onChange(document: DrawingDocument): void;
  onClose(): void;
  /** Called on Done - the persistence adapter's entry point. The engine has
   * no idea whether this writes to a quiz answer, a scouting report, or
   * nothing at all, which is what keeps it reusable. */
  onDone?(document: DrawingDocument): void | Promise<void>;
  /** Rendered inside the overlay, above the toolbar. The spike passes its
   * HUD here; production passes nothing. */
  renderOverlay?(telemetry: BoardTelemetry): React.ReactNode;
  saveState?: 'idle' | 'saving' | 'saved' | 'error';
  /** Overrides the grace window. Exists so the spike HUD can sweep the value
   * on real hardware - the production board leaves it at the default. */
  graceMs?: number;
}

const TOOLS: { id: DrawingTool; label: string; icon: IconName }[] = [
  { id: 'pen', label: 'Pen', icon: 'pen' },
  { id: 'pan', label: 'Pan', icon: 'pan' },
  { id: 'eraser', label: 'Erase', icon: 'eraser' },
];

export function DrawingBoard({
  imageUrl,
  document: initialDocument,
  onChange,
  onClose,
  onDone,
  renderOverlay,
  saveState = 'idle',
  graceMs,
}: DrawingBoardProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<DrawingEngine | null>(null);
  const arbiterRef = useRef<GestureArbiter>(new GestureArbiter());
  /** Undo/redo over whole documents. Documents are immutable and small
   * enough that snapshotting is simpler and far less error-prone than
   * replaying inverse operations - and it makes Clear undoable for free. */
  const pastRef = useRef<DrawingDocument[]>([]);
  const futureRef = useRef<DrawingDocument[]>([]);
  const documentRef = useRef(initialDocument);
  /** Distinguishes a real orientation flip from an incidental box change. */
  const wasLandscapeRef = useRef(false);

  const [tool, setTool] = useState<DrawingTool>('pen');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [telemetry, setTelemetry] = useState<BoardTelemetry>(() => initialTelemetry(initialDocument));

  useScrollLock(true);

  useEffect(() => {
    if (graceMs !== undefined) arbiterRef.current.setConfig({ graceMs });
  }, [graceMs]);

  const publish = useCallback(
    (next: DrawingDocument) => {
      documentRef.current = next;
      setCanUndo(pastRef.current.length > 0);
      setCanRedo(futureRef.current.length > 0);
      setTelemetry((prev) => ({ ...prev, strokeCount: next.strokes.length }));
      onChange(next);
    },
    [onChange],
  );

  // --- engine lifecycle --------------------------------------------------
  useEffect(() => {
    const element = canvasRef.current;
    const surface = surfaceRef.current;
    if (!element || !surface) return;

    const cssWidth = surface.clientWidth;
    const cssHeight = surface.clientHeight;
    const render = resolveRenderScale({
      viewportWidth: cssWidth,
      viewportHeight: cssHeight,
      devicePixelRatio: window.devicePixelRatio,
    });

    const engine = new DrawingEngine(element, initialDocument, {
      onDocumentChange: (next) => publish(next),
      onZoomChange: (zoom) => setTelemetry((prev) => ({ ...prev, zoom })),
    });
    engineRef.current = engine;

    // The backing store is sized from the render scale, not from the CSS box:
    // the CSS box is how big the board looks, the backing store is how much
    // memory it costs, and conflating them is the Safari crash.
    engine.resize(render, cssWidth, cssHeight);
    setTelemetry((prev) => ({
      ...prev,
      render,
      viewport: { width: cssWidth, height: cssHeight },
    }));

    void engine.setSourceImage(imageUrl).then(() => {
      engine.resetView();
      setTelemetry((prev) => ({ ...prev, zoom: engine.getZoom() }));
    });

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
    // Intentionally constructed once per open: re-running this would discard
    // in-progress strokes. Document updates flow through the engine instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  // --- command application ----------------------------------------------
  const apply = useCallback(
    (commands: ArbiterCommand[]) => {
      const engine = engineRef.current;
      if (!engine || commands.length === 0) return;

      for (const command of commands) {
        switch (command.type) {
          case 'strokeBegin':
            pastRef.current.push(documentRef.current);
            futureRef.current = [];
            engine.strokeBegin(command.point.x, command.point.y);
            break;
          case 'strokeExtend':
            engine.strokeExtend(command.point.x, command.point.y);
            break;
          case 'strokeEnd':
            engine.strokeEnd();
            break;
          case 'strokeAbort':
            // The history entry pushed at strokeBegin has to come back off,
            // or Undo would restore a state identical to the current one and
            // look broken.
            pastRef.current.pop();
            engine.strokeAbort();
            setCanUndo(pastRef.current.length > 0);
            break;
          case 'strokeDiscard':
            // Nothing was ever drawn or pushed. This is the stray mark that
            // did not happen.
            break;
          case 'transform':
            engine.zoomBy(command.scaleBy, command.focal.x, command.focal.y);
            engine.panBy(command.panBy.x, command.panBy.y);
            break;
          case 'pan':
            engine.panBy(command.by.x, command.by.y);
            break;
          case 'eraseAt': {
            const previous = documentRef.current;
            const removed = engine.eraseAt(command.point.x, command.point.y);
            if (removed) {
              pastRef.current.push(previous);
              futureRef.current = [];
              setCanUndo(true);
              setCanRedo(false);
            }
            break;
          }
        }
      }
    },
    [],
  );

  // --- pointer plumbing --------------------------------------------------
  const localPoint = useCallback((event: React.PointerEvent) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return {
      x: event.clientX - (rect?.left ?? 0),
      y: event.clientY - (rect?.top ?? 0),
      t: event.timeStamp,
    };
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      const point = localPoint(event);
      // Pointer capture keeps the stroke alive when the finger leaves the
      // canvas bounds mid-stroke. It can throw for a pointer the browser has
      // already released (Safari does this around interruptions) - a failure
      // here must degrade to "no capture", never abort the gesture.
      try {
        (event.target as Element).setPointerCapture(event.pointerId);
      } catch {
        /* capture is an optimization, not a requirement */
      }
      apply(arbiterRef.current.pointerDown({ id: event.pointerId, ...point }));
    },
    [apply, localPoint],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      apply(arbiterRef.current.pointerMove({ id: event.pointerId, ...localPoint(event) }));
    },
    [apply, localPoint],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent) => {
      try {
        (event.target as Element).releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      apply(arbiterRef.current.pointerUp({ id: event.pointerId, ...localPoint(event) }));
    },
    [apply, localPoint],
  );

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent) => {
      apply(arbiterRef.current.pointerCancel({ id: event.pointerId, ...localPoint(event) }));
    },
    [apply, localPoint],
  );

  // --- frame loop: arbiter clock, pinch flush, FPS -----------------------
  useEffect(() => {
    let frame = 0;
    let last = performance.now();
    let frames = 0;
    let accumulated = 0;

    const step = (now: number) => {
      const delta = now - last;
      last = now;
      frames += 1;
      accumulated += delta;

      apply(arbiterRef.current.tick(now));

      if (accumulated >= 500) {
        const fps = Math.round((frames * 1000) / accumulated);
        const arbiter = arbiterRef.current;
        const metrics = arbiter.getMetrics();
        setTelemetry((prev) => ({
          ...prev,
          fps,
          pointerCount: arbiter.getPointerCount(),
          gesture: arbiter.getState(),
          zoom: engineRef.current?.getZoom() ?? prev.zoom,
          preventedStrays: metrics.discardedBySecondPointer,
          suspectedStrays: metrics.suspectedStrays,
        }));
        frames = 0;
        accumulated = 0;
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [apply]);

  // --- orientation and resize -------------------------------------------
  useEffect(() => {
    // ResizeObserver fires once on observe() with the element's current size.
    // That first callback is not a resize - and acting on it would fight the
    // initial fit that runs when the source image finishes loading.
    let seenInitialObservation = false;

    function handleResize() {
      const engine = engineRef.current;
      const surface = surfaceRef.current;
      if (!engine || !surface) return;
      if (!seenInitialObservation) {
        seenInitialObservation = true;
        wasLandscapeRef.current = surface.clientWidth >= surface.clientHeight;
        return;
      }

      // Any in-flight gesture is abandoned: the geometry it was measured
      // against no longer exists.
      apply(arbiterRef.current.reset());

      const cssWidth = surface.clientWidth;
      const cssHeight = surface.clientHeight;
      const render = resolveRenderScale({
        viewportWidth: cssWidth,
        viewportHeight: cssHeight,
        devicePixelRatio: window.devicePixelRatio,
      });
      // What the player is looking at, captured before the geometry changes.
      const center = engine.getSceneCenter();
      const cssZoom = engine.getCssZoom();
      const landscape = cssWidth >= cssHeight;

      // Backing store and CSS box are recomputed; the coordinate space is
      // not, so no stroke moves.
      engine.resize(render, cssWidth, cssHeight);

      // A genuine orientation flip re-fits the image, because the old framing
      // is meaningless in the new aspect. Anything else - notably iOS
      // collapsing its URL bar - restores the previous view, so a player who
      // had zoomed into the box does not get yanked back out mid-answer.
      if (wasLandscapeRef.current !== landscape) {
        engine.resetView();
        wasLandscapeRef.current = landscape;
      } else {
        engine.centerOn(center, cssZoom);
      }
      setTelemetry((prev) => ({
        ...prev,
        render,
        viewport: { width: cssWidth, height: cssHeight },
        orientation: readOrientation(),
        zoom: engine.getZoom(),
      }));
    }

    // A ResizeObserver on the surface itself, not just window resize events.
    // The board's box can change without the window doing so - iOS Safari
    // collapsing its URL bar is the common case, and a stale backing store
    // there means every touch lands offset from the ink. The window listeners
    // stay as well: orientationchange can fire before layout settles, and
    // catching both is cheaper than missing one.
    const observer = new ResizeObserver(handleResize);
    if (surfaceRef.current) observer.observe(surfaceRef.current);
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [apply]);

  // Backgrounding the browser mid-stroke leaves a pointer the OS will never
  // lift; drop it rather than resuming into a stroke from a stale origin.
  useEffect(() => {
    function handleVisibility() {
      if (window.document.visibilityState === 'hidden') apply(arbiterRef.current.reset());
    }
    window.document.addEventListener('visibilitychange', handleVisibility);
    return () => window.document.removeEventListener('visibilitychange', handleVisibility);
  }, [apply]);

  // --- toolbar actions ---------------------------------------------------
  function changeTool(next: DrawingTool) {
    apply(arbiterRef.current.setTool(next));
    setTool(next);
  }

  function undo() {
    const engine = engineRef.current;
    const previous = pastRef.current.pop();
    if (!engine || !previous) return;
    futureRef.current.push(documentRef.current);
    void engine.applyDocument(previous);
  }

  function redo() {
    const engine = engineRef.current;
    const next = futureRef.current.pop();
    if (!engine || !next) return;
    pastRef.current.push(documentRef.current);
    void engine.applyDocument(next);
  }

  function clear() {
    const engine = engineRef.current;
    if (!engine || documentRef.current.strokes.length === 0) return;
    pastRef.current.push(documentRef.current);
    futureRef.current = [];
    void engine.applyDocument({ ...documentRef.current, strokes: [] });
  }

  function resetView() {
    engineRef.current?.resetView();
  }

  async function done() {
    apply(arbiterRef.current.reset());
    await onDone?.(documentRef.current);
    onClose();
  }

  return createPortal(
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Draw on image">
      <div
        ref={surfaceRef}
        className={styles.surface}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handlePointerCancel}
        // Hands every touch to the arbiter. Without this the browser claims
        // one-finger drags for scrolling before any handler runs, and no
        // amount of preventDefault in JS gets it back.
        style={{ touchAction: 'none' }}
      >
        <canvas ref={canvasRef} className={styles.canvas} />
      </div>

      {renderOverlay?.(telemetry)}

      <div className={styles.toolbar}>
        <div className={styles.toolGroup} role="group" aria-label="Tools">
          {TOOLS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={entry.id === tool ? `${styles.toolButton} ${styles.toolButtonActive}` : styles.toolButton}
              onClick={() => changeTool(entry.id)}
              aria-pressed={entry.id === tool}
            >
              <Icon name={entry.icon} size={20} />
              <span>{entry.label}</span>
            </button>
          ))}
        </div>

        <div className={styles.toolGroup}>
          <button type="button" className={styles.toolButton} onClick={undo} disabled={!canUndo}>
            <Icon name="undo" size={20} />
            <span>Undo</span>
          </button>
          <button type="button" className={styles.toolButton} onClick={redo} disabled={!canRedo}>
            <Icon name="redo" size={20} />
            <span>Redo</span>
          </button>
          <button type="button" className={styles.toolButton} onClick={clear}>
            <span>Clear</span>
          </button>
          <button type="button" className={styles.toolButton} onClick={resetView}>
            <span>Reset view</span>
          </button>
        </div>

        <div className={styles.toolGroup}>
          {saveState !== 'idle' && <span className={styles.saveState}>{SAVE_LABELS[saveState]}</span>}
          <button type="button" className={styles.doneButton} onClick={() => void done()}>
            Done
          </button>
          <button type="button" className={styles.toolButton} onClick={onClose} aria-label="Close without saving">
            <Icon name="close" size={20} />
          </button>
        </div>
      </div>
    </div>,
    window.document.body,
  );
}

const SAVE_LABELS: Record<NonNullable<DrawingBoardProps['saveState']>, string> = {
  idle: '',
  saving: 'Saving...',
  saved: 'Saved',
  error: 'Not saved',
};

function readOrientation(): string {
  return window.innerWidth >= window.innerHeight ? 'landscape' : 'portrait';
}

function initialTelemetry(document: DrawingDocument): BoardTelemetry {
  return {
    fps: 0,
    pointerCount: 0,
    gesture: 'idle',
    zoom: 1,
    strokeCount: document.strokes.length,
    render: {
      scale: 1,
      backingWidth: document.coordinate_width,
      backingHeight: document.coordinate_height,
      estimatedBytes: 0,
      cappedByMemory: false,
    },
    viewport: { width: 0, height: 0 },
    orientation: 'portrait',
    preventedStrays: 0,
    suspectedStrays: 0,
  };
}
