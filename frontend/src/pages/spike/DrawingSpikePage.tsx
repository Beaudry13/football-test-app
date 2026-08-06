import { useCallback, useMemo, useState } from 'react';
import { DrawingBoard, type BoardTelemetry } from '../../components/drawing/DrawingBoard';
import { createDocument, hasDrawnAnswer, validateDocument } from '../../components/drawing/drawingDocument';
import { DEFAULT_ARBITER_CONFIG } from '../../components/drawing/gestureArbiter';
import type { DrawingDocument, DrawingSourceImage } from '../../components/drawing/types';
import { SPIKE_IMAGE_URL, SPIKE_IMAGE_SIZE } from './spikeImage';
import { DrawingHud } from './DrawingHud';
import styles from './DrawingSpikePage.module.css';

/** Phase 0 spike. Development only - see the route guard in App.tsx.
 *
 * Exercises the real engine module, not a copy of it: whatever passes here is
 * what production would ship. Persistence is localStorage rather than the API
 * so the gate can run against a laptop on hotel wifi with the backend down,
 * and so no production schema change is needed to test gestures.
 *
 * The long block of text above the launcher is deliberate. Scroll lock only
 * fails in an interesting way when there is something to scroll: the tester
 * must be able to scroll down, open the board, draw near the top edge, close
 * it, and land back exactly where they were.
 */

const STORAGE_KEY = 'peira.spike.drawing.v1';

const SOURCE: DrawingSourceImage = {
  image_id: 'spike-still-1',
  image_version: 'v1',
  natural_width: SPIKE_IMAGE_SIZE.width,
  natural_height: SPIKE_IMAGE_SIZE.height,
};

export function DrawingSpikePage() {
  const [open, setOpen] = useState(false);
  const [graceMs, setGraceMs] = useState(DEFAULT_ARBITER_CONFIG.graceMs);
  const [manualStrays, setManualStrays] = useState(0);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [document, setDocument] = useState<DrawingDocument>(() => loadDocument() ?? createDocument({ source: SOURCE }));

  const problems = useMemo(() => validateDocument(document), [document]);

  const handleChange = useCallback((next: DrawingDocument) => {
    setDocument(next);
    // Stands in for the debounced autosave the production board will run
    // against the API - same shape, no network.
    setSaveState('saving');
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, []);

  function resetDrawing() {
    const fresh = createDocument({ source: SOURCE });
    window.localStorage.removeItem(STORAGE_KEY);
    setDocument(fresh);
    setSaveState('idle');
  }

  const renderHud = useCallback(
    (telemetry: BoardTelemetry) => (
      <DrawingHud
        telemetry={telemetry}
        manualStrays={manualStrays}
        onTallyStray={() => setManualStrays((count) => count + 1)}
        onResetTally={() => setManualStrays(0)}
        graceMs={graceMs}
        onGraceChange={setGraceMs}
        saveState={saveState}
      />
    ),
    [manualStrays, graceMs, saveState],
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <p className={styles.tag}>Phase 0 spike - development only</p>
        <h1>Draw on Image</h1>
        <p className={styles.lede}>
          Gesture and memory validation for the Draw on Image question type. Not a production route, not
          linked from anywhere, and excluded from the production bundle.
        </p>
      </header>

      <section className={styles.status}>
        <dl>
          <div>
            <dt>Strokes</dt>
            <dd>{document.strokes.length}</dd>
          </div>
          <div>
            <dt>Counts as an answer</dt>
            <dd>{hasDrawnAnswer(document) ? 'yes' : 'no'}</dd>
          </div>
          <div>
            <dt>Coordinate space</dt>
            <dd>
              {document.coordinate_width} x {document.coordinate_height}
            </dd>
          </div>
          <div>
            <dt>Document valid</dt>
            <dd>{problems.length === 0 ? 'yes' : problems.join('; ')}</dd>
          </div>
          <div>
            <dt>Restored from storage</dt>
            <dd>{window.localStorage.getItem(STORAGE_KEY) ? 'yes' : 'no'}</dd>
          </div>
        </dl>
      </section>

      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => setOpen(true)}>
          Open drawing board
        </button>
        <button type="button" className={styles.secondary} onClick={resetDrawing}>
          Clear saved drawing
        </button>
      </div>

      <section className={styles.protocol}>
        <h2>Gate protocol</h2>
        <ol>
          <li>Scroll this page to the bottom, then open the board. Closing it must return you here.</li>
          <li>Draw slowly, then fast. Ink must stay under your fingertip.</li>
          <li>Start a stroke and immediately add a second finger. Watch the stray counters.</li>
          <li>Pinch in and out repeatedly. No mark may appear.</li>
          <li>Zoom past 2x and draw. Check for drift between finger and ink.</li>
          <li>Two-finger pan while zoomed, then switch to the Pan tool and use one finger.</li>
          <li>Erase a stroke, undo it, redo it, then Clear and undo that.</li>
          <li>Rotate the phone. Background the browser and come back.</li>
          <li>Draw continuously for two minutes, then check FPS and canvas memory.</li>
          <li>Reload the page - the drawing must come back.</li>
        </ol>
        <p className={styles.filler}>
          The text below exists so the page is taller than the viewport. Scroll lock is only meaningfully
          testable when there is something behind the overlay that could scroll, and the failure it guards
          against - the page moving under your finger mid-stroke - cannot happen on a short page.
        </p>
        {Array.from({ length: 8 }, (_, index) => (
          <p key={index} className={styles.filler}>
            Peira spike filler paragraph {index + 1}. Every trial has its coach.
          </p>
        ))}
      </section>

      {open && (
        <DrawingBoard
          imageUrl={SPIKE_IMAGE_URL}
          document={document}
          onChange={handleChange}
          onClose={() => setOpen(false)}
          onDone={handleChange}
          renderOverlay={renderHud}
          saveState={saveState}
          graceMs={graceMs}
        />
      )}
    </div>
  );
}

function loadDocument(): DrawingDocument | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DrawingDocument;
    // Resume must refuse a document it cannot trust rather than rendering a
    // half-valid one - the production resume path will make the same call.
    return validateDocument(parsed).length === 0 ? parsed : null;
  } catch {
    return null;
  }
}

export default DrawingSpikePage;
