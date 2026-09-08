import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import nb from '../../styles/notebook.module.css';
import styles from './ClipEditor.module.css';
import { CLIP_BITS_PER_SECOND, formatClipDuration } from './clipRecording';
import {
  type CropRect,
  type TrimRange,
  encodeCropTrim,
  fullFrameCrop,
  fullTrim,
  MIN_CROP_PX,
  MIN_TRIM_MS,
  needsReencode,
  normaliseCrop,
  normaliseTrim,
  remapDecisionPoint,
} from './clipEditing';

const FPS = 30;

export interface EditedClip {
  blob: Blob;
  width: number;
  height: number;
  durationMs: number;
  /** Null when the trim removed it and the coach chose to clear it. */
  decisionPointMs: number | null;
  /** False when the coach changed nothing - the ORIGINAL blob came back. */
  wasEdited: boolean;
}

interface ClipEditorProps {
  blob: Blob;
  previewUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  durationMs: number;
  mimeType: string;
  /** Only set when re-recording over a clip that already had one. */
  decisionPointMs?: number | null;
  onDone: (edited: EditedClip) => void;
  onCancel: () => void;
}

type Phase = 'editing' | 'processing' | 'failed';
type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w' | 'move';

/** Trim and crop a clip the coach has just recorded.
 *
 * A CLEANUP STEP, NOT AN APPLICATION. Pull the edges in, cut the run-up and
 * the tail off, look at it, keep it. There is no split, no speed, no filter
 * and no export dialog, because none of those are things a coach reaches for
 * between recording a play and asking a question about it.
 *
 * DOING NOTHING IS FREE. Every control starts at the value that means "leave
 * it alone" - full frame, full duration - and if they are all still there when
 * the coach presses Use, the ORIGINAL blob is handed back untouched. No
 * encode, no wait, no generation loss, byte-identical to Record Clip before
 * this screen existed. See `needsReencode`.
 *
 * THE EXPENSIVE WORK HAPPENS ONCE, ON PURPOSE. Dragging a handle re-renders a
 * CSS overlay, never a re-encode; the single pass runs when the coach commits.
 * It costs roughly one second per second of retained clip, which is why the
 * progress read-out counts MEDIA seconds rather than spinning.
 */
export function ClipEditor({
  blob,
  previewUrl,
  sourceWidth,
  sourceHeight,
  durationMs,
  mimeType,
  decisionPointMs = null,
  onDone,
  onCancel,
}: ClipEditorProps) {
  const [crop, setCrop] = useState<CropRect>(() => fullFrameCrop(sourceWidth, sourceHeight));
  const [range, setRange] = useState<TrimRange>(() => fullTrim(durationMs));
  const [phase, setPhase] = useState<Phase>('editing');
  const [progress, setProgress] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  /** Set when the coach explicitly accepts losing a decision point the trim
   *  removes. Never inferred - see the notice below. */
  const [decisionPointCleared, setDecisionPointCleared] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ handle: Handle; startX: number; startY: number; origin: CropRect } | null>(
    null,
  );

  const edited = needsReencode(crop, range, sourceWidth, sourceHeight, durationMs);
  const decision = remapDecisionPoint(decisionPointCleared ? null : decisionPointMs, range);
  const blockedByDecisionPoint = !decision.ok;

  /* THE PREVIEW PLAYS ONLY THE RETAINED RANGE, so what the coach approves is
     what the player gets. Looping by hand rather than with the `loop`
     attribute, because native loop always returns to zero - which is exactly
     the run-up the coach just cut off. */
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const startS = range.startMs / 1000;
    const endS = range.endMs / 1000;
    if (el.currentTime < startS || el.currentTime > endS) el.currentTime = startS;
    const onTime = () => {
      if (el.currentTime >= endS) el.currentTime = startS;
    };
    el.addEventListener('timeupdate', onTime);
    return () => el.removeEventListener('timeupdate', onTime);
  }, [range]);

  // --- crop dragging, in SOURCE pixels ------------------------------------
  const pointerToSource = useCallback(
    (event: PointerEvent | React.PointerEvent) => {
      const rect = frameRef.current?.getBoundingClientRect();
      if (!rect || !rect.width) return { x: 0, y: 0 };
      return {
        x: ((event.clientX - rect.left) / rect.width) * sourceWidth,
        y: ((event.clientY - rect.top) / rect.height) * sourceHeight,
      };
    },
    [sourceWidth, sourceHeight],
  );

  const beginDrag = (handle: Handle) => (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const point = pointerToSource(event);
    dragRef.current = { handle, startX: point.x, startY: point.y, origin: { ...crop } };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const point = pointerToSource(event);
      const dx = point.x - drag.startX;
      const dy = point.y - drag.startY;
      const o = drag.origin;
      let next: CropRect;

      if (drag.handle === 'move') {
        // Repositioning keeps the SIZE and only moves the origin, clamped so
        // the rectangle cannot be pushed off the frame.
        next = {
          x: Math.min(Math.max(0, o.x + dx), sourceWidth - o.w),
          y: Math.min(Math.max(0, o.y + dy), sourceHeight - o.h),
          w: o.w,
          h: o.h,
        };
      } else {
        const west = drag.handle.includes('w');
        const east = drag.handle.includes('e');
        const north = drag.handle.includes('n');
        const south = drag.handle.includes('s');
        let { x, y, w, h } = o;
        if (west) {
          const shift = Math.min(Math.max(dx, -o.x), o.w - MIN_CROP_PX);
          x = o.x + shift;
          w = o.w - shift;
        }
        if (east) w = Math.min(Math.max(MIN_CROP_PX, o.w + dx), sourceWidth - o.x);
        if (north) {
          const shift = Math.min(Math.max(dy, -o.y), o.h - MIN_CROP_PX);
          y = o.y + shift;
          h = o.h - shift;
        }
        if (south) h = Math.min(Math.max(MIN_CROP_PX, o.h + dy), sourceHeight - o.y);
        next = { x, y, w, h };
      }
      // Normalised on every move, so what is displayed is what will encode -
      // the coach never sees a rectangle the encoder would refuse.
      setCrop(normaliseCrop(next, sourceWidth, sourceHeight));
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [pointerToSource, sourceWidth, sourceHeight]);

  const pct = useMemo(
    () => ({
      left: (crop.x / sourceWidth) * 100,
      top: (crop.y / sourceHeight) * 100,
      width: (crop.w / sourceWidth) * 100,
      height: (crop.h / sourceHeight) * 100,
    }),
    [crop, sourceWidth, sourceHeight],
  );

  function reset() {
    setCrop(fullFrameCrop(sourceWidth, sourceHeight));
    setRange(fullTrim(durationMs));
    setDecisionPointCleared(false);
    setFailure(null);
    setPhase('editing');
  }

  async function commit() {
    if (blockedByDecisionPoint) return;

    // THE PASSTHROUGH. Nothing was changed, so nothing is re-encoded.
    if (!edited) {
      onDone({
        blob,
        width: sourceWidth,
        height: sourceHeight,
        durationMs,
        decisionPointMs: decisionPointCleared ? null : (decisionPointMs ?? null),
        wasEdited: false,
      });
      return;
    }

    setPhase('processing');
    setProgress(0);
    setFailure(null);
    try {
      const result = await encodeCropTrim({
        blob,
        crop,
        range,
        mimeType,
        bitsPerSecond: CLIP_BITS_PER_SECOND,
        fps: FPS,
        onProgress: setProgress,
      });
      onDone({
        blob: result.blob,
        width: result.width,
        height: result.height,
        durationMs: result.durationMs,
        decisionPointMs: decision.ok ? decision.value : null,
        wasEdited: true,
      });
    } catch (err) {
      // THE ORIGINAL IS UNTOUCHED. `blob` was never reassigned, so both
      // recovery paths below still have the coach's recording.
      setFailure(err instanceof Error ? err.message : 'Something went wrong applying your edits.');
      setPhase('failed');
    }
  }

  function useOriginal() {
    onDone({
      blob,
      width: sourceWidth,
      height: sourceHeight,
      durationMs,
      decisionPointMs: decisionPointMs ?? null,
      wasEdited: false,
    });
  }

  const retainedMs = range.endMs - range.startMs;
  const startPct = (range.startMs / Math.max(1, durationMs)) * 100;
  const endPct = (range.endMs / Math.max(1, durationMs)) * 100;

  if (phase === 'processing') {
    const totalS = Math.round(retainedMs / 1000);
    const doneS = Math.min(totalS, Math.round((progress * retainedMs) / 1000));
    return (
      <div className={styles.editor}>
        <p className={styles.processing} role="status" aria-live="polite">
          Applying edits… {doneS} of {totalS} seconds
        </p>
        <div className={styles.progressTrack} aria-hidden="true">
          <div className={styles.progressFill} style={{ width: `${progress * 100}%` }} />
        </div>
        <p className={styles.processingHint}>This takes about as long as the clip itself.</p>
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <div className={styles.editor}>
        <p className={styles.failure} role="alert">
          {failure} Your recording is safe.
        </p>
        <div className={styles.actions}>
          <button type="button" className={nb.btnPrimary} onClick={() => void commit()}>
            Try again
          </button>
          {/* NEVER LOSE A GOOD TAKE because an optional edit failed. */}
          <button type="button" className={nb.btnSecondary} onClick={useOriginal}>
            Use original
          </button>
          <button type="button" className={nb.btnSecondary} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.editor}>
      <div className={styles.frame} ref={frameRef}>
        <video
          ref={videoRef}
          className={styles.video}
          src={previewUrl}
          autoPlay
          muted
          playsInline
        />
        {/* The subdued area is four panes around the crop rather than a hole
            punched in one overlay: a box-shadow trick breaks the moment the
            video is letterboxed inside its box. */}
        <div className={styles.shade} style={{ left: 0, top: 0, right: 0, height: `${pct.top}%` }} />
        <div
          className={styles.shade}
          style={{ left: 0, top: `${pct.top + pct.height}%`, right: 0, bottom: 0 }}
        />
        <div
          className={styles.shade}
          style={{ left: 0, top: `${pct.top}%`, width: `${pct.left}%`, height: `${pct.height}%` }}
        />
        <div
          className={styles.shade}
          style={{
            left: `${pct.left + pct.width}%`,
            top: `${pct.top}%`,
            right: 0,
            height: `${pct.height}%`,
          }}
        />
        <div
          className={styles.cropBox}
          style={{
            left: `${pct.left}%`,
            top: `${pct.top}%`,
            width: `${pct.width}%`,
            height: `${pct.height}%`,
          }}
          onPointerDown={beginDrag('move')}
          role="group"
          aria-label="Crop area"
        >
          {(['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'] as const).map((handle) => (
            <span
              key={handle}
              className={`${styles.handle} ${styles[handle]}`}
              onPointerDown={beginDrag(handle)}
              data-handle={handle}
            />
          ))}
        </div>
      </div>

      <p className={styles.readout}>
        {formatClipDuration(range.startMs)} — {formatClipDuration(range.endMs)} ·{' '}
        {(retainedMs / 1000).toFixed(1)} sec · {crop.w}×{crop.h}
      </p>

      {/* Two ordinary range inputs rather than a custom scrubber. They are
          keyboard-operable for free, and this is a "cut the run-up off"
          control, not a frame-accurate editor. */}
      <div className={styles.timeline}>
        <div className={styles.timelineTrack} aria-hidden="true">
          <div
            className={styles.timelineKept}
            style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
          />
        </div>
        <input
          type="range"
          className={`${styles.slider} ${styles.sliderStart}`}
          min={0}
          max={durationMs}
          step={100}
          value={range.startMs}
          aria-label="Trim start"
          onChange={(e) =>
            setRange((r) => normaliseTrim({ ...r, startMs: Number(e.target.value) }, durationMs))
          }
        />
        <input
          type="range"
          className={`${styles.slider} ${styles.sliderEnd}`}
          min={0}
          max={durationMs}
          step={100}
          value={range.endMs}
          aria-label="Trim end"
          onChange={(e) =>
            setRange((r) => normaliseTrim({ ...r, endMs: Number(e.target.value) }, durationMs))
          }
        />
      </div>

      {/* SAY WHY SAVE IS OFF, and offer the way out in the same breath - a
          disabled button with no explanation is the thing this avoids. */}
      {blockedByDecisionPoint && (
        <div className={styles.blocked} role="alert">
          <p>
            This trim removes the decision point you set. Move the handles back, or clear the
            decision point to keep this trim.
          </p>
          <button
            type="button"
            className={nb.btnSm}
            onClick={() => setDecisionPointCleared(true)}
          >
            Clear decision point
          </button>
        </div>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={nb.btnPrimary}
          onClick={() => void commit()}
          disabled={blockedByDecisionPoint}
        >
          Use clip
        </button>
        <button type="button" className={nb.btnSecondary} onClick={reset}>
          Reset
        </button>
        <button type="button" className={nb.btnSecondary} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {!edited && (
        <p className={styles.untouchedHint}>
          No changes yet — your clip will be saved exactly as recorded.
        </p>
      )}
    </div>
  );
}

export const CLIP_EDITOR_MIN_TRIM_MS = MIN_TRIM_MS;
