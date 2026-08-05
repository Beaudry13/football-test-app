import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Canvas, FabricImage, PencilBrush, Point, type FabricObject } from 'fabric';
import {
  DEFAULT_GESTURE_CONFIG,
  initialGestureState,
  pointerDown,
  pointerMove,
  pointerUp,
  type GestureEffect,
  type GestureState,
  type Tool,
} from './drawingGestures';
import { clampScale, MAX_SCALE, MIN_SCALE } from '../components/pinchZoomMath';
import { clearDraft, loadDraft, saveDraft } from './drawingDraftStore';
import { useBodyScrollLock } from './useBodyScrollLock';
import styles from './DrawingSpikePage.module.css';

/* ────────────────────────────────────────────────────────────────────────
   PHASE 0 SPIKE - throwaway harness, not shipped code.
   Registered only under import.meta.env.DEV (see App.tsx), so it never
   reaches production. Its job is to answer, on real hardware, the seven
   questions in docs/DESIGN-draw-on-image.md that no amount of desktop
   testing can settle.

   Everything is instrumented on-screen because you cannot open devtools on
   a phone in a locker room. The HUD is the deliverable.
   ──────────────────────────────────────────────────────────────────────── */

const DRAFT_KEY = 'spike-question-1';
const PLAYER_STROKE_COLOR = '#FF3B30';
const COACH_STROKE_COLOR = '#C9A24B';
const CANVAS_WIDTH = 1400;

/** Stand-in film still, generated rather than fetched so the spike works
 * offline (airplane-mode testing is one of the things we need to try). */
function makeFieldImage(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#1d2a1f';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#3f5943';
  ctx.lineWidth = 3;
  for (let x = 0; x < width; x += width / 12) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  ctx.strokeStyle = '#d6dbd2';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, height * 0.55);
  ctx.lineTo(width, height * 0.55);
  ctx.stroke();
  ctx.fillStyle = '#efe7cf';
  for (let i = 0; i < 7; i++) {
    ctx.beginPath();
    ctx.arc(width * 0.18 + i * (width * 0.1), height * 0.55, 16, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#8ea3ff';
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(width * 0.28 + i * (width * 0.14), height * 0.3, 16, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.font = '28px sans-serif';
  ctx.fillStyle = '#efe7cf';
  ctx.fillText('SPIKE FIXTURE — TRIPS RIGHT, 2nd & 7', 24, 44);
  return canvas;
}

interface Telemetry {
  phase: string;
  pointers: number;
  scale: number;
  strokes: number;
  points: number;
  backingStore: string;
  memoryMb: string;
  fps: number;
  strayCommitted: number;
  strayPrevented: number;
  saveState: string;
  restored: string;
}

export function DrawingSpikePage() {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.host}>
      <h1>Draw on Image — Phase 0 spike</h1>
      <p>
        Throwaway harness for real-device testing. Open this page on an actual iPhone and an actual
        Android phone. The panel inside reports everything you need; there is nothing to read in a
        console.
      </p>
      <ol className={styles.checklist}>
        <li>Open the board. Does the quiz page behind it disappear completely?</li>
        <li>Try to scroll the page while the board is open, and while drawing. Nothing should move.</li>
        <li>Pinch to zoom repeatedly. Watch <b>stray marks</b> — it must stay at 0.</li>
        <li>Zoom to 4x and draw. Does the ink land exactly under your fingertip?</li>
        <li>Draw heavily for a minute. Watch <b>FPS</b> and <b>est. memory</b>.</li>
        <li>Draw, then pull down to refresh the page. Reopen. Is the drawing still there?</li>
        <li>Turn on airplane mode, draw, refresh. Still there? (Local draft, no network.)</li>
        <li>Rotate the phone. Strokes must stay glued to the image, not rescale.</li>
      </ol>
      <p className={styles.spacerNote}>
        There is deliberately a lot of scrollable page here so you can prove the scroll lock works.
      </p>
      <div className={styles.spacer} aria-hidden="true" />
      <button type="button" className={styles.openButton} onClick={() => setOpen(true)}>
        Tap to draw your answer
      </button>
      <div className={styles.spacer} aria-hidden="true" />
      {open && <DrawingBoard onClose={() => setOpen(false)} />}
    </div>
  );
}

function DrawingBoard({ onClose }: { onClose: () => void }) {
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const fabricRef = useRef<Canvas | null>(null);
  const brushRef = useRef<PencilBrush | null>(null);
  const gestureRef = useRef<GestureState>(initialGestureState());
  const toolRef = useRef<Tool>('pen');
  const strokeCountRef = useRef(0);
  const liveStrokeRef = useRef(false);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);

  const [tool, setTool] = useState<Tool>('pen');
  const [ready, setReady] = useState(false);
  const [telemetry, setTelemetry] = useState<Telemetry>({
    phase: 'idle',
    pointers: 0,
    scale: 1,
    strokes: 0,
    points: 0,
    backingStore: '—',
    memoryMb: '—',
    fps: 0,
    strayCommitted: 0,
    strayPrevented: 0,
    saveState: 'idle',
    restored: 'checking…',
  });

  useBodyScrollLock(true);
  useEffect(() => {
    toolRef.current = tool;
    // The pan tool must not leave the brush armed, or a stray pointerdown
    // that slips past arbitration would paint.
    if (fabricRef.current) fabricRef.current.isDrawingMode = false;
  }, [tool]);

  const patch = useCallback((next: Partial<Telemetry>) => setTelemetry((t) => ({ ...t, ...next })), []);

  /* ── history (snapshot-based, same approach as useAnnotationHistory) ── */
  const pushHistory = useCallback(() => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const snapshot = JSON.stringify(canvas.toObject(['peiraLayer']));
    historyRef.current = historyRef.current.slice(0, historyIndexRef.current + 1);
    historyRef.current.push(snapshot);
    historyIndexRef.current = historyRef.current.length - 1;
  }, []);

  const persist = useCallback(async () => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    patch({ saveState: 'saving…' });
    const strokes = canvas
      .getObjects()
      .filter((o) => (o as FabricObject & { peiraLayer?: string }).peiraLayer === 'player')
      .map((o) => o.toObject(['peiraLayer']));
    const ok = await saveDraft({
      key: DRAFT_KEY,
      strokes,
      canvasWidth: CANVAS_WIDTH,
      canvasHeight: canvas.getHeight(),
      updatedAt: Date.now(),
    });
    patch({ saveState: ok ? `saved ${new Date().toLocaleTimeString()}` : 'SAVE FAILED' });
  }, [patch]);

  /* ── canvas setup ── */
  useEffect(() => {
    if (!canvasElRef.current) return;
    let disposed = false;

    async function setup() {
      const el = canvasElRef.current!;
      // Render scale is chosen from the device, NOT from the desktop
      // constant - a 2x backing store on a 1400px coordinate space is ~20MB
      // and is the memory risk called out in the design doc. Coordinate
      // space stays CANVAS_WIDTH regardless, so strokes never shift.
      const dpr = window.devicePixelRatio || 1;
      const renderScale = Math.min(dpr, window.innerWidth < 500 ? 1.5 : 2);
      const fieldW = CANVAS_WIDTH;
      const fieldH = Math.round(CANVAS_WIDTH * 0.62);

      const canvas = new Canvas(el, {
        enableRetinaScaling: false,
        selection: false,
        preserveObjectStacking: true,
        backgroundColor: '#0d0f0e',
      });
      if (disposed) {
        canvas.dispose();
        return;
      }
      fabricRef.current = canvas;

      const backingW = Math.round(fieldW * renderScale);
      const backingH = Math.round(fieldH * renderScale);
      canvas.setDimensions({ width: backingW, height: backingH }, { backstoreOnly: true });
      canvas.setDimensions({ width: '100%', height: '100%' }, { cssOnly: true });

      const bg = new FabricImage(makeFieldImage(fieldW, fieldH), {
        selectable: false,
        evented: false,
        originX: 'left',
        originY: 'top',
      });
      canvas.backgroundImage = bg;

      // A coach pre-annotation, so the spike also proves the two-layer
      // colour separation decision (fixed player colour vs coach gold).
      const coachMark = new PencilBrush(canvas);
      coachMark.color = COACH_STROKE_COLOR;
      coachMark.width = 6;

      const brush = new PencilBrush(canvas);
      brush.color = PLAYER_STROKE_COLOR;
      brush.width = 8;
      // Higher than the 0.4 default: on a phone a dense stroke generates a
      // very large point array, and this is the knob that controls it.
      brush.decimate = 2.5;
      canvas.freeDrawingBrush = brush;
      brushRef.current = brush;

      canvas.setZoom(renderScale);
      canvas.renderAll();

      const draft = await loadDraft(DRAFT_KEY);
      if (draft && Array.isArray(draft.strokes) && draft.strokes.length > 0 && !disposed) {
        await canvas.loadFromJSON({ objects: draft.strokes });
        canvas.backgroundImage = bg;
        canvas.setZoom(renderScale);
        canvas.renderAll();
        strokeCountRef.current = draft.strokes.length;
        patch({
          restored: `restored ${draft.strokes.length} strokes from ${new Date(draft.updatedAt).toLocaleTimeString()}`,
          strokes: draft.strokes.length,
        });
      } else {
        patch({ restored: 'no draft found (fresh start)' });
      }

      patch({
        backingStore: `${backingW}×${backingH} @${renderScale.toFixed(2)}x (dpr ${dpr})`,
        memoryMb: `${((backingW * backingH * 4) / 1024 / 1024).toFixed(1)} MB`,
      });
      pushHistory();
      setReady(true);
    }

    setup();
    return () => {
      disposed = true;
      fabricRef.current?.dispose();
      fabricRef.current = null;
    };
  }, [patch, pushHistory]);

  /* ── FPS meter ── */
  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - last >= 1000) {
        patch({ fps: frames });
        frames = 0;
        last = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [patch]);

  /* ── translating gesture effects into canvas operations ── */
  const applyEffect = useCallback(
    (effect: GestureEffect, nativeEvent: PointerEvent) => {
      const canvas = fabricRef.current;
      const brush = brushRef.current;
      if (!canvas || !brush) return;

      if (effect.discardedPending) {
        setTelemetry((t) => ({ ...t, strayPrevented: t.strayPrevented + 1 }));
      }

      if (effect.abortStroke) {
        // A stroke was already committed when the 2nd finger landed. Remove
        // it so the pinch leaves no mark. Counted separately from prevented
        // ones: a healthy build should show this at or near zero, because
        // the grace window should catch nearly every pinch first.
        brush.onMouseUp({ e: nativeEvent } as never);
        const objects = canvas.getObjects();
        const last = objects[objects.length - 1];
        if (last && (last as FabricObject & { peiraLayer?: string }).peiraLayer === undefined) {
          canvas.remove(last);
        }
        liveStrokeRef.current = false;
        canvas.renderAll();
        setTelemetry((t) => ({ ...t, strayCommitted: t.strayCommitted + 1 }));
      }

      if (effect.beginStroke) {
        // getScenePoint inverse-transforms through the viewport, which is
        // what makes drawing land under the fingertip at any zoom level -
        // the reason zoom is applied inside Fabric rather than via CSS.
        const first = canvas.getScenePoint(nativeEvent);
        brush.onMouseDown(first, { e: nativeEvent } as never);
        liveStrokeRef.current = true;
      }

      if (effect.extendStroke && liveStrokeRef.current) {
        brush.onMouseMove(canvas.getScenePoint(nativeEvent), { e: nativeEvent } as never);
      }

      if (effect.endStroke && liveStrokeRef.current) {
        brush.onMouseUp({ e: nativeEvent } as never);
        liveStrokeRef.current = false;
        const objects = canvas.getObjects();
        const last = objects[objects.length - 1];
        if (last) (last as FabricObject & { peiraLayer?: string }).peiraLayer = 'player';
        strokeCountRef.current = objects.length;
        pushHistory();
        void persist();
        setTelemetry((t) => ({
          ...t,
          strokes: objects.length,
          points: objects.reduce(
            (sum, o) => sum + ((o as unknown as { path?: unknown[] }).path?.length ?? 0),
            0,
          ),
        }));
      }

      if (effect.eraseAt) {
        // Whole-stroke deletion (product decision 1). findTarget respects
        // the viewport transform, so this is zoom-correct for free.
        const target = canvas.findTarget(nativeEvent);
        if (target) {
          canvas.remove(target);
          canvas.renderAll();
          strokeCountRef.current = canvas.getObjects().length;
          pushHistory();
          void persist();
          setTelemetry((t) => ({ ...t, strokes: canvas.getObjects().length }));
        }
      }

      if (effect.zoomTo) {
        const scale = clampScale(effect.zoomTo.scale, MIN_SCALE, MAX_SCALE);
        const rect = canvas.getElement().getBoundingClientRect();
        canvas.zoomToPoint(
          new Point(effect.zoomTo.focal.x - rect.left, effect.zoomTo.focal.y - rect.top),
          scale,
        );
        setTelemetry((t) => ({ ...t, scale }));
      }

      if (effect.panBy) {
        canvas.relativePan(new Point(effect.panBy.dx, effect.panBy.dy));
      }
    },
    [persist, pushHistory],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Capture keeps a finger's events coming to this element even if it
    // slides over the toolbar mid-stroke. Guarded because it throws
    // NotFoundError for a pointer id the browser doesn't consider active -
    // which is every synthetic event, and would silently abort the whole
    // handler. Losing capture is survivable; losing the gesture is not.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /* capture unavailable - drawing still works, it just won't track
         outside the surface */
    }
    const canvas = fabricRef.current;
    const result = pointerDown(
      gestureRef.current,
      { id: event.pointerId, x: event.clientX, y: event.clientY },
      toolRef.current,
      performance.now(),
      canvas?.getZoom() ?? 1,
      DEFAULT_GESTURE_CONFIG,
    );
    gestureRef.current = result.state;
    applyEffect(result.effect, event.nativeEvent);
    patch({ phase: result.state.phase.kind, pointers: result.state.pointers.size });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const result = pointerMove(
      gestureRef.current,
      { id: event.pointerId, x: event.clientX, y: event.clientY },
      toolRef.current,
      performance.now(),
      DEFAULT_GESTURE_CONFIG,
    );
    gestureRef.current = result.state;
    applyEffect(result.effect, event.nativeEvent);
    patch({ phase: result.state.phase.kind, pointers: result.state.pointers.size });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const result = pointerUp(gestureRef.current, event.pointerId, toolRef.current);
    gestureRef.current = result.state;
    applyEffect(result.effect, event.nativeEvent);
    patch({ phase: result.state.phase.kind, pointers: result.state.pointers.size });
  };

  const restore = useCallback(
    async (index: number) => {
      const canvas = fabricRef.current;
      const snapshot = historyRef.current[index];
      if (!canvas || !snapshot) return;
      const bg = canvas.backgroundImage;
      const zoom = canvas.getZoom();
      const vpt = canvas.viewportTransform;
      await canvas.loadFromJSON(JSON.parse(snapshot));
      canvas.backgroundImage = bg;
      canvas.setViewportTransform(vpt);
      canvas.setZoom(zoom);
      canvas.renderAll();
      historyIndexRef.current = index;
      setTelemetry((t) => ({ ...t, strokes: canvas.getObjects().length }));
      void persist();
    },
    [persist],
  );

  const resetView = () => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const renderScale = Math.min(dpr, window.innerWidth < 500 ? 1.5 : 2);
    canvas.setViewportTransform([renderScale, 0, 0, renderScale, 0, 0]);
    canvas.renderAll();
    patch({ scale: renderScale });
  };

  const clearAll = () => {
    const canvas = fabricRef.current;
    if (!canvas) return;
    canvas.remove(...canvas.getObjects());
    canvas.renderAll();
    pushHistory();
    void persist();
    patch({ strokes: 0, points: 0 });
  };

  return createPortal(
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Drawing spike">
      <div className={styles.topBar}>
        <button
          type="button"
          className={styles.barButton}
          onClick={() => {
            void clearDraft(DRAFT_KEY);
            onClose();
          }}
        >
          Cancel + wipe draft
        </button>
        <span className={styles.title}>Q1 · Draw your run fit</span>
        <button type="button" className={`${styles.barButton} ${styles.done}`} onClick={onClose}>
          Done
        </button>
      </div>

      <div
        className={styles.surface}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <canvas ref={canvasElRef} className={styles.canvas} />
        {!ready && <p className={styles.loading}>Preparing board…</p>}
      </div>

      <Hud telemetry={telemetry} />

      <div className={styles.toolBar}>
        {(['pen', 'eraser', 'pan'] as Tool[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`${styles.tool} ${tool === t ? styles.toolActive : ''}`}
            onClick={() => setTool(t)}
          >
            {t === 'pen' ? 'Pen' : t === 'eraser' ? 'Eraser' : 'Pan'}
          </button>
        ))}
        <button type="button" className={styles.tool} onClick={() => restore(historyIndexRef.current - 1)}>
          Undo
        </button>
        <button type="button" className={styles.tool} onClick={() => restore(historyIndexRef.current + 1)}>
          Redo
        </button>
        <button type="button" className={styles.tool} onClick={resetView}>
          Reset view
        </button>
        <button type="button" className={styles.tool} onClick={clearAll}>
          Clear
        </button>
      </div>
    </div>,
    document.body,
  );
}

function Hud({ telemetry }: { telemetry: Telemetry }) {
  const strayBad = telemetry.strayCommitted > 0;
  return (
    <div className={styles.hud}>
      <Row label="phase" value={`${telemetry.phase} · ${telemetry.pointers} pointer(s)`} />
      <Row label="zoom" value={`${telemetry.scale.toFixed(2)}x`} />
      <Row label="strokes / points" value={`${telemetry.strokes} / ${telemetry.points}`} />
      <Row label="backing store" value={telemetry.backingStore} />
      <Row label="est. memory" value={telemetry.memoryMb} />
      <Row label="fps" value={String(telemetry.fps)} warn={telemetry.fps > 0 && telemetry.fps < 40} />
      <Row label="stray marks" value={String(telemetry.strayCommitted)} warn={strayBad} />
      <Row label="pinches caught early" value={String(telemetry.strayPrevented)} />
      <Row label="draft" value={telemetry.saveState} />
      <Row label="on load" value={telemetry.restored} />
      <Row
        label="device"
        value={`${window.innerWidth}×${window.innerHeight} · dvh ${CSS.supports('height: 100dvh') ? 'yes' : 'NO'}`}
      />
    </div>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={styles.hudRow}>
      <span className={styles.hudLabel}>{label}</span>
      <span className={warn ? styles.hudValueWarn : styles.hudValue}>{value}</span>
    </div>
  );
}
