/** Crop and trim rules for Record Clip, kept free of React so they can be
 * tested directly - the same split `clipRecording.ts` already uses.
 *
 * ---------------------------------------------------------------------------
 * DOING NOTHING MUST COST NOTHING
 * ---------------------------------------------------------------------------
 *
 * A coach who does not touch the crop handles or the trim bar gets the
 * ORIGINAL recorded blob, unchanged, byte for byte. No canvas, no second
 * encode, no wait, no generation loss. `needsReencode` is the gate, and it is
 * the most important function in this file: editing is an optional cleanup
 * step bolted onto a pipeline that already works, and it must stay invisible
 * to everyone who does not ask for it.
 *
 * ---------------------------------------------------------------------------
 * EVEN DIMENSIONS ARE NOT A DETAIL
 * ---------------------------------------------------------------------------
 *
 * H.264 subsamples chroma 2x2, so an odd width or height is a real encoder
 * failure rather than a theoretical one. The crop rectangle a coach drags is
 * continuous; what reaches the encoder is snapped to even numbers by
 * `normaliseCrop`, which rounds INWARD so the result can never spill outside
 * the source frame it came from.
 */

/** A crop rectangle in SOURCE PIXELS. Not normalised fractions: the encoder
 *  works in pixels, and converting once at the edge beats converting at every
 *  drag, every clamp and every assertion. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TrimRange {
  /** Milliseconds from the start of the recording. */
  startMs: number;
  endMs: number;
}

/** The shortest clip worth keeping, in milliseconds.
 *
 * ONE SECOND, chosen against the product rather than picked round. Record Clip
 * caps a take at 20 seconds because a single football play cannot usefully
 * fill more; the same reasoning at the other end says a play cannot usefully
 * occupy less than about a second, and a sub-second clip on native `loop`
 * reads as a flicker rather than a play. It also keeps the trim handles from
 * being able to collapse onto each other and produce a zero-length encode,
 * which no amount of downstream validation would make sensible.
 */
export const MIN_TRIM_MS = 1_000;

/** The smallest crop the encoder is asked to produce. Two pixels is the
 *  chroma floor; 64 is the smallest rectangle a coach could plausibly mean,
 *  and stops a stray drag producing a postage stamp. */
export const MIN_CROP_PX = 64;

export function fullFrameCrop(width: number, height: number): CropRect {
  return { x: 0, y: 0, w: width, h: height };
}

export function fullTrim(durationMs: number): TrimRange {
  return { startMs: 0, endMs: durationMs };
}

function evenDown(value: number): number {
  return Math.max(0, Math.floor(value / 2) * 2);
}

/** Clamp a crop inside the source frame and snap it to even dimensions.
 *
 * ROUNDS INWARD, ALWAYS. Rounding a width up is how a normalisation step
 * quietly pushes a rectangle past the right edge of the frame it was measured
 * against - the source pixels are not there, and `drawImage` would sample
 * nothing. Losing at most one pixel per axis is the cheap side of that trade.
 */
export function normaliseCrop(crop: CropRect, sourceW: number, sourceH: number): CropRect {
  const maxW = evenDown(sourceW);
  const maxH = evenDown(sourceH);

  // Origin first: a crop can only be clamped meaningfully once it is inside.
  const x = Math.min(Math.max(0, Math.round(crop.x)), Math.max(0, sourceW - MIN_CROP_PX));
  const y = Math.min(Math.max(0, Math.round(crop.y)), Math.max(0, sourceH - MIN_CROP_PX));

  const availableW = sourceW - x;
  const availableH = sourceH - y;
  const w = evenDown(Math.min(Math.max(MIN_CROP_PX, Math.round(crop.w)), availableW));
  const h = evenDown(Math.min(Math.max(MIN_CROP_PX, Math.round(crop.h)), availableH));

  return {
    x: evenDown(x),
    y: evenDown(y),
    // A source smaller than the floor is degenerate but must not produce a
    // negative or odd result; the whole frame is the honest answer.
    w: Math.max(2, Math.min(w, maxW)),
    h: Math.max(2, Math.min(h, maxH)),
  };
}

/** Keep a trim range ordered, inside the recording, and long enough to be a
 *  clip. The END is what moves when the two would cross, because a coach
 *  dragging the start handle past the end is expressing "start later", not
 *  "invert the clip". */
export function normaliseTrim(range: TrimRange, durationMs: number): TrimRange {
  const limit = Math.max(MIN_TRIM_MS, Math.round(durationMs));
  let startMs = Math.min(Math.max(0, Math.round(range.startMs)), limit - MIN_TRIM_MS);
  let endMs = Math.min(Math.max(0, Math.round(range.endMs)), limit);
  if (endMs - startMs < MIN_TRIM_MS) {
    endMs = Math.min(limit, startMs + MIN_TRIM_MS);
    // Only if the end hit the ceiling does the start give way instead.
    if (endMs - startMs < MIN_TRIM_MS) startMs = Math.max(0, endMs - MIN_TRIM_MS);
  }
  return { startMs, endMs };
}

export function isFullFrame(crop: CropRect, sourceW: number, sourceH: number): boolean {
  return crop.x === 0 && crop.y === 0 && crop.w === sourceW && crop.h === sourceH;
}

export function isFullDuration(range: TrimRange, durationMs: number): boolean {
  // A few milliseconds of slack at the end: a recorder's reported duration and
  // the media's own are routinely a frame apart, and a coach who never touched
  // the handle must not be charged for an encode because of it.
  return range.startMs === 0 && range.endMs >= durationMs - 40;
}

/** THE PASSTHROUGH GATE. False means the original blob is used untouched. */
export function needsReencode(
  crop: CropRect,
  range: TrimRange,
  sourceW: number,
  sourceH: number,
  durationMs: number,
): boolean {
  return !isFullFrame(crop, sourceW, sourceH) || !isFullDuration(range, durationMs);
}

// ---------------------------------------------------------------------------
// Decision Point
// ---------------------------------------------------------------------------

export type DecisionPointOutcome =
  | { ok: true; value: number | null }
  | { ok: false; reason: 'outside-retained-range' };

/** Where a decision point lands after a trim.
 *
 * STRICTLY INSIDE, and the strictness is the point. A point exactly at the
 * trim start would freeze the film before a single frame has played; one
 * exactly at the end never stops anything, because the clip has already
 * finished. Both are "the trim removed your decision point" wearing a
 * disguise.
 *
 * REFUSES RATHER THAN CLAMPS, matching `validate_decision_point_ms` on the
 * server. The coach chose that frame by watching the film and pausing on it;
 * silently moving it would change what a player is shown at the moment the
 * whole feature exists to control, and nothing would say so.
 */
export function remapDecisionPoint(
  decisionPointMs: number | null | undefined,
  range: TrimRange,
): DecisionPointOutcome {
  if (decisionPointMs == null) return { ok: true, value: null };
  if (decisionPointMs <= range.startMs || decisionPointMs >= range.endMs) {
    return { ok: false, reason: 'outside-retained-range' };
  }
  return { ok: true, value: decisionPointMs - range.startMs };
}

// ---------------------------------------------------------------------------
// The encode
// ---------------------------------------------------------------------------

export interface EncodeInput {
  blob: Blob;
  crop: CropRect;
  range: TrimRange;
  mimeType: string;
  bitsPerSecond: number;
  fps: number;
  /** 0..1, driven by MEDIA time rather than wall time - the coach is told how
   *  much of their clip is done, which is the thing they can verify. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface EncodeResult {
  blob: Blob;
  width: number;
  height: number;
  durationMs: number;
  framesPainted: number;
}

/** Crop and trim in ONE pass, producing a new H.264 MP4.
 *
 * Measured in the Phase 0 spike against a 20s 1080p source: output kept
 * `ftyp` at 0 and `moov` at 36 - the front-loaded, fragmented layout the R2
 * ranged-read path and iOS Safari both depend on - and came out 55% smaller
 * than the source. Nothing downstream can tell an edited clip from a recorded
 * one, which is exactly why no backend change was needed.
 *
 * THE SEEK HAPPENS BEFORE `start()`, so not one frame of pre-roll is ever
 * encoded. Cropping and trimming are the same pass; there is no intermediate
 * encode and therefore only one generation of loss.
 */
export async function encodeCropTrim(input: EncodeInput): Promise<EncodeResult> {
  const { blob, crop, range, mimeType, bitsPerSecond, fps } = input;

  const video = document.createElement('video');
  video.src = URL.createObjectURL(blob);
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('The recording could not be opened for editing.'));
    });

    const canvas = document.createElement('canvas');
    canvas.width = crop.w;
    canvas.height = crop.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser could not prepare the clip for editing.');

    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: bitsPerSecond });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    const startS = range.startMs / 1000;
    const endS = range.endMs / 1000;

    video.currentTime = startS;
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      // A seek that never lands must not hang the coach forever.
      setTimeout(resolve, 3000);
    });

    let framesPainted = 0;
    recorder.start();
    await video.play();

    await new Promise<void>((resolve) => {
      const span = Math.max(1, endS - startS);
      const pump = () => {
        if (input.signal?.aborted) return resolve();
        if (video.currentTime >= endS || video.ended) return resolve();
        ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
        framesPainted++;
        input.onProgress?.(Math.min(1, (video.currentTime - startS) / span));
        // rVFC paints once per DECODED frame, so the output tracks the source
        // rather than the display. rAF is the fallback where it is missing.
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => pump());
        else requestAnimationFrame(pump);
      };
      pump();
    });

    video.pause();
    recorder.stop();
    await stopped;

    const out = new Blob(chunks, { type: mimeType });
    if (!out.size) throw new Error('Editing produced an empty clip.');
    input.onProgress?.(1);

    return {
      blob: out,
      width: crop.w,
      height: crop.h,
      durationMs: range.endMs - range.startMs,
      framesPainted,
    };
  } finally {
    // The object URL, not the blob: the ORIGINAL recording must survive
    // whatever happened above, because it is the coach's only copy.
    URL.revokeObjectURL(video.src);
  }
}
