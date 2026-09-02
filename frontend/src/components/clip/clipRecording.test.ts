import { describe, expect, it } from 'vitest';
import {
  CLIP_BITS_PER_SECOND,
  DISPLAY_MEDIA_CONSTRAINTS,
  MAX_CLIP_MS,
  MP4_CANDIDATES,
  detectClipCapability,
  elapsedSeconds,
  formatClipDuration,
  pickMp4MimeType,
  recorderOptions,
} from './clipRecording';

/** THE GUARD AGAINST SHIPPING PLAYER-INCOMPATIBLE MEDIA.
 *
 * A Phase 0 spike measured Chrome 151 and Edge 152 both DEFAULTING to
 * Matroska/WebM and both producing a genuine H.264 MP4 when asked explicitly.
 * WebM is not an acceptable fallback: iOS Safari does not reliably play
 * VP8/VP9, so a coach would record something that plays on their laptop and
 * shows a blank rectangle to half their squad - with no error anywhere.
 *
 * These tests exist because that failure is silent. Nothing throws, nothing
 * logs, and the coach has no way to discover it.
 */

/** A MediaRecorder-shaped stub. Real MediaRecorder does not exist in jsdom,
 *  which is exactly why the module takes it as an argument. */
const recorderSupporting = (supported: string[]) => ({
  isTypeSupported: (mime: string) => supported.includes(mime),
});

describe('MP4 detection', () => {
  it('only ever offers MP4 candidates', () => {
    // If a WebM type were ever added to this list, every other guard here
    // would still pass while the feature quietly regressed.
    for (const candidate of MP4_CANDIDATES) {
      expect(candidate.startsWith('video/mp4')).toBe(true);
    }
  });

  it('prefers the fully-specified Baseline profile the spike verified', () => {
    const recorder = recorderSupporting([...MP4_CANDIDATES]);
    expect(pickMp4MimeType(recorder)).toBe('video/mp4;codecs="avc1.42E01E"');
  });

  it('falls back through the looser MP4 spellings, never past them', () => {
    expect(pickMp4MimeType(recorderSupporting(['video/mp4;codecs=avc1']))).toBe(
      'video/mp4;codecs=avc1',
    );
    expect(pickMp4MimeType(recorderSupporting(['video/mp4']))).toBe('video/mp4');
  });

  it('returns null - never WebM - when only WebM is recordable', () => {
    // The measured default state of both Chromium browsers when no mimeType
    // is named. Returning a WebM type here is the one outcome that would
    // reach an iPhone as a blank rectangle.
    const webmOnly = recorderSupporting([
      'video/webm',
      'video/webm;codecs=vp8',
      'video/webm;codecs=vp9',
    ]);
    expect(pickMp4MimeType(webmOnly)).toBeNull();
  });

  it('does not trust the intuitive codecs=h264 spelling', () => {
    // Measured false on Chrome 151 and Edge 152 while codecs=avc1 - the same
    // codec - is true. A browser that somehow supported ONLY that spelling
    // must not be treated as MP4-capable by these candidates.
    expect(pickMp4MimeType(recorderSupporting(['video/mp4;codecs=h264']))).toBeNull();
  });

  it('treats a missing or throwing MediaRecorder as unsupported', () => {
    expect(pickMp4MimeType(null)).toBeNull();
    expect(pickMp4MimeType({})).toBeNull();
    expect(
      pickMp4MimeType({
        isTypeSupported: () => {
          throw new Error('nope');
        },
      }),
    ).toBeNull();
  });
});

describe('capability detection', () => {
  it('is supported only with both screen capture and MP4', () => {
    const result = detectClipCapability({
      hasDisplayMedia: true,
      recorder: recorderSupporting([...MP4_CANDIDATES]),
    });
    expect(result).toEqual({
      supported: true,
      mimeType: 'video/mp4;codecs="avc1.42E01E"',
      reason: 'ok',
    });
  });

  it('refuses when the browser can capture but cannot record MP4', () => {
    const result = detectClipCapability({
      hasDisplayMedia: true,
      recorder: recorderSupporting(['video/webm;codecs=vp9']),
    });
    expect(result.supported).toBe(false);
    expect(result.mimeType).toBeNull();
    expect(result.reason).toBe('no-mp4');
  });

  it('refuses where screen capture does not exist at all', () => {
    // iOS (every browser, all WebKit) and Android Chrome. This is what keeps
    // the control off a phone rather than a user-agent sniff.
    const result = detectClipCapability({
      hasDisplayMedia: false,
      recorder: recorderSupporting([...MP4_CANDIDATES]),
    });
    expect(result.supported).toBe(false);
    expect(result.reason).toBe('no-display-media');
  });
});

describe('recording settings', () => {
  it('never requests audio', () => {
    // No microphone and no system audio: a screen recording that captured a
    // meeting would be a privacy incident, and muted autoplay means a player
    // would never hear it anyway.
    expect(DISPLAY_MEDIA_CONSTRAINTS.audio).toBe(false);
  });

  it('caps the clip at twenty seconds', () => {
    expect(MAX_CLIP_MS).toBe(20_000);
  });

  it('passes the chosen MP4 type and a bitrate ceiling to the recorder', () => {
    const options = recorderOptions('video/mp4;codecs=avc1');
    expect(options.mimeType).toBe('video/mp4;codecs=avc1');
    expect(options.videoBitsPerSecond).toBe(CLIP_BITS_PER_SECOND);
  });
});

describe('elapsed counter', () => {
  it('counts whole seconds and stops at the cap', () => {
    expect(elapsedSeconds(1_000, 1_000)).toBe(0);
    expect(elapsedSeconds(1_000, 9_400)).toBe(8);
    // Never shows 21/20 if a timer fires late.
    expect(elapsedSeconds(1_000, 99_000)).toBe(20);
  });
});

describe('capture resolution', () => {
  it('caps the captured frame at 1080p-class without cropping or stretching', () => {
    // Only frameRate was constrained, so sharing a 4K monitor captured 4K and
    // spent the same bitrate ceiling on four times the pixels - worse football
    // than a sane 1080p capture of the same film, because the first thing to
    // smear at too few bits per pixel is small high-contrast detail. Which is
    // what a jersey number is.
    const video = DISPLAY_MEDIA_CONSTRAINTS.video as MediaTrackConstraints;
    expect(video.width).toEqual({ max: 1920 });
    expect(video.height).toEqual({ max: 1080 });
  });

  it('constrains only the maximum, so a smaller window is never upscaled', () => {
    const video = DISPLAY_MEDIA_CONSTRAINTS.video as MediaTrackConstraints;
    for (const dimension of [video.width, video.height]) {
      const constraint = dimension as ConstrainULongRange;
      expect(constraint.min).toBeUndefined();
      expect(constraint.exact).toBeUndefined();
      // `ideal` is advisory and would be ignored on exactly the oversized
      // sources this exists for.
      expect(constraint.ideal).toBeUndefined();
    }
  });

  it('still never asks for audio', () => {
    // A screen recording that captured a meeting would be a privacy incident.
    expect(DISPLAY_MEDIA_CONSTRAINTS.audio).toBe(false);
  });

  it('still asks for 30fps', () => {
    const video = DISPLAY_MEDIA_CONSTRAINTS.video as MediaTrackConstraints;
    expect(video.frameRate).toBe(30);
  });
});

describe('formatClipDuration', () => {
  it('reads as a timecode a coach can scan', () => {
    expect(formatClipDuration(8000)).toBe('0:08');
    expect(formatClipDuration(20000)).toBe('0:20');
    expect(formatClipDuration(65000)).toBe('1:05');
  });

  it('rounds to the nearest second rather than truncating', () => {
    // A 7.6s take reading "0:07" invites a coach to think the recorder lost
    // the end of it.
    expect(formatClipDuration(7600)).toBe('0:08');
    expect(formatClipDuration(7400)).toBe('0:07');
  });

  it('says nothing rather than something wrong when there is no duration', () => {
    expect(formatClipDuration(null)).toBeNull();
    expect(formatClipDuration(undefined)).toBeNull();
    expect(formatClipDuration(0)).toBeNull();
    expect(formatClipDuration(Number.NaN)).toBeNull();
  });
});
