/** Recording rules for Record Clip, kept free of React and the DOM so they
 * can be tested directly.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THAT MATTERS: NEVER FALL BACK TO WEBM
 * ---------------------------------------------------------------------------
 *
 * A Phase 0 spike measured Chrome 151 and Edge 152. Both report `video/mp4`
 * as recordable and both produce a genuine MP4 - ISO-BMFF, H.264 Baseline
 * profile, level 3.2, verified by parsing the box tree rather than trusting
 * the MIME label. And both DEFAULT to Matroska/WebM carrying VP8 when no
 * `mimeType` is passed.
 *
 * WebM is not an acceptable fallback. Player playback is overwhelmingly on
 * phones, iPhones included, and iOS Safari does not reliably play VP8/VP9
 * WebM. A coach who recorded one would see it play perfectly on their laptop
 * and have no way to know half their squad gets a blank rectangle - a failure
 * with no error, no warning and no feedback path.
 *
 * So this module refuses. If the browser cannot record H.264 MP4 the coach is
 * told BEFORE recording, and no capture is started at all.
 *
 * ---------------------------------------------------------------------------
 * A TRAP WORTH THE COMMENT
 * ---------------------------------------------------------------------------
 *
 * `video/mp4;codecs=h264` returns FALSE on both browsers. `codecs=avc1` - the
 * same codec, spelled the way the ISO registry spells it - returns true. The
 * intuitive spelling is the wrong one, and getting it wrong does not throw:
 * detection simply concludes MP4 is unsupported and every coach silently
 * falls back. That is why the candidates below are ordered and explicit, and
 * why a test asserts every one of them is an MP4 type.
 */

/** Ordered most-specific first: naming the profile gets the exact Baseline
 *  stream the spike verified, and the looser spellings are there for a
 *  browser that supports MP4 recording but rejects a full codec string. */
export const MP4_CANDIDATES = [
  'video/mp4;codecs="avc1.42E01E"',
  'video/mp4;codecs=avc1',
  'video/mp4',
] as const;

/** 15 seconds. The recorder stops itself here; a coach may stop sooner. */
export const MAX_CLIP_MS = 15_000;

/** A ceiling, not a target. The spike measured ~124 kbps for real motion at
 *  1280x860, so this only ever binds on a large, busy capture - which is
 *  exactly the case worth bounding. */
export const CLIP_BITS_PER_SECOND = 2_500_000;

export const UNSUPPORTED_MESSAGE =
  "Record Clip needs a browser that can record MP4 video. Update Chrome or Edge, " +
  'or use one of those on a desktop computer.';

type TypeSupportFn = (mime: string) => boolean;

/** The MediaRecorder-shaped surface this module needs, so tests can supply a
 *  fake rather than depending on a jsdom that has no MediaRecorder at all. */
export interface RecorderLike {
  isTypeSupported?: TypeSupportFn;
}

/** The first MP4 type this browser will actually record, or null.
 *
 * Null means "do not record", never "record something else". */
export function pickMp4MimeType(recorder?: RecorderLike | null): string | null {
  const isSupported = recorder?.isTypeSupported;
  if (typeof isSupported !== 'function') return null;
  for (const candidate of MP4_CANDIDATES) {
    try {
      if (isSupported(candidate)) return candidate;
    } catch {
      // A browser that throws on an unfamiliar type is telling us no.
    }
  }
  return null;
}

export interface CapabilityInput {
  hasDisplayMedia: boolean;
  recorder?: RecorderLike | null;
}

export interface Capability {
  supported: boolean;
  mimeType: string | null;
  /** Why not, for a message a coach can act on. */
  reason: 'ok' | 'no-display-media' | 'no-mp4';
}

/** Whether this browser can author a clip at all.
 *
 * Screen capture is desktop-only in practice - `getDisplayMedia` is absent on
 * iOS entirely (every iOS browser is WebKit underneath) and on Android
 * Chrome - so its absence is the signal used to hide the feature on a phone
 * rather than a separate user-agent sniff.
 */
export function detectClipCapability({
  hasDisplayMedia,
  recorder,
}: CapabilityInput): Capability {
  if (!hasDisplayMedia) {
    return { supported: false, mimeType: null, reason: 'no-display-media' };
  }
  const mimeType = pickMp4MimeType(recorder);
  if (!mimeType) {
    return { supported: false, mimeType: null, reason: 'no-mp4' };
  }
  return { supported: true, mimeType, reason: 'ok' };
}

/** Video only, explicitly. No microphone, no system audio - a screen
 *  recording that captured a meeting would be a privacy incident, and the
 *  player never hears it anyway because muted autoplay is mandatory. */
export const DISPLAY_MEDIA_CONSTRAINTS: MediaStreamConstraints = {
  video: { frameRate: 30 },
  audio: false,
};

/** Options for a recorder that must produce MP4 or nothing. */
export function recorderOptions(mimeType: string) {
  return { mimeType, videoBitsPerSecond: CLIP_BITS_PER_SECOND };
}

/** Whole seconds elapsed, clamped to the cap - for "RECORDING · 08 / 15". */
export function elapsedSeconds(startedAt: number, now: number): number {
  return Math.min(Math.floor(Math.max(0, now - startedAt) / 1000), MAX_CLIP_MS / 1000);
}
