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

/** 20 seconds. The recorder stops itself here; a coach may stop sooner.
 *
 * WHY 20 AND NOT 15, AND WHY NOT 30
 * ---------------------------------
 * The question a coach actually asks is "here is the alignment, here is the
 * motion - what happens?", and that needs the WHOLE moment: pre-snap read
 * (4-6s), plus snap to whistle (6-9s), plus the second or two of human slack
 * at each end that a coach cannot avoid while also watching the film. That
 * lands at 12-17s, so 15 worked only when the coach was perfectly precise -
 * and the part that got cut was the pre-snap read, which is the part that
 * makes it a coaching question rather than a highlight.
 *
 * 30 was rejected: a single football play cannot usefully fill it, so the
 * space would be filled by a SECOND play, and one question would start
 * carrying a film session. 20 is the largest cap that still holds exactly
 * one moment.
 */
export const MAX_CLIP_MS = 20_000;

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
 *  player never hears it anyway because muted autoplay is mandatory.
 *
 *  CAPPED AT 1080p-CLASS, AND WHY THAT IS A QUALITY FIX RATHER THAN A LIMIT.
 *  Only `frameRate` was constrained, so sharing a 4K monitor captured 4K and
 *  then spent the same bitrate ceiling on four times the pixels. The result
 *  was WORSE football than a sane 1080p capture of the same film: the first
 *  thing to smear at too few bits per pixel is small high-contrast detail,
 *  which is exactly what a jersey number is.
 *
 *  `max` never upscales, so a 1280x720 window is untouched. A larger source
 *  is scaled DOWN proportionally - the browser fits the frame inside the box
 *  rather than cropping or stretching it, so the football keeps its shape.
 *  Height is capped too: width alone would leave a portrait monitor or a very
 *  tall window uncapped.
 *
 *  `max` rather than `ideal` because ideal is advisory and would simply be
 *  ignored on the sources that need it most. It cannot over-constrain here -
 *  downscaling always satisfies a maximum - so it introduces no way to fail.
 */
export const DISPLAY_MEDIA_CONSTRAINTS: MediaStreamConstraints = {
  video: { frameRate: 30, width: { max: 1920 }, height: { max: 1080 } },
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

/** "0:08". The length of a take, for a coach who has just recorded it.
 *
 * Rounds to the NEAREST second rather than truncating: a 7.6s take reading
 * "0:07" invites a coach to think the recorder lost the end of it.
 */
export function formatClipDuration(durationMs: number | null | undefined): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  const total = Math.round(durationMs / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
