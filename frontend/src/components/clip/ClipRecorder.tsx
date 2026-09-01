import { useCallback, useEffect, useRef, useState } from 'react';
import nb from '../../styles/notebook.module.css';
import styles from './ClipRecorder.module.css';
import {
  DISPLAY_MEDIA_CONSTRAINTS,
  MAX_CLIP_MS,
  UNSUPPORTED_MESSAGE,
  detectClipCapability,
  elapsedSeconds,
  recorderOptions,
} from './clipRecording';

export interface RecordedClip {
  blob: Blob;
  poster: Blob | null;
  durationMs: number;
  width: number;
  height: number;
  previewUrl: string;
}

/** Record a short silent clip of the coach's screen.
 *
 * A TOOL, NOT AN APPLICATION. Start, stop, look at it, keep it or throw it
 * away. No timeline, no trimming, no crop - the browser's own picker already
 * crops by letting a coach choose one window or tab, at the operating-system
 * level, before a single frame is encoded.
 *
 * FAILS BEFORE RECORDING, NEVER AFTER. Capability is checked up front, and a
 * browser that cannot produce MP4 gets a message instead of a Start button.
 * The alternative - record, then discover at save time - would waste the
 * coach's take and leave them with nothing.
 */
export function ClipRecorder({
  onUse,
  onCancel,
}: {
  onUse: (clip: RecordedClip) => void;
  onCancel: () => void;
}) {
  const [capability] = useState(() =>
    detectClipCapability({
      hasDisplayMedia: Boolean(navigator.mediaDevices?.getDisplayMedia),
      recorder: typeof MediaRecorder === 'undefined' ? null : MediaRecorder,
    }),
  );

  const [phase, setPhase] = useState<'idle' | 'recording' | 'preview'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [clip, setClip] = useState<RecordedClip | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);

  /** Ends the capture and, importantly, the browser's sharing indicator.
   *  Leaving tracks live keeps the OS telling the coach their screen is being
   *  shared after they have stopped, which reads as a bug and is alarming. */
  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    if (tickRef.current) window.clearInterval(tickRef.current);
    stopTimerRef.current = null;
    tickRef.current = null;
  }, []);

  useEffect(() => releaseStream, [releaseStream]);

  async function start() {
    if (!capability.supported || !capability.mimeType) return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(DISPLAY_MEDIA_CONSTRAINTS);
    } catch (err) {
      // Cancelling the picker is the overwhelmingly common case and is not an
      // error worth shouting about.
      const name = (err as DOMException)?.name;
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        setError('Screen recording could not start. Check your browser permissions.');
      }
      return;
    }
    streamRef.current = stream;

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream, recorderOptions(capability.mimeType));
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };

    const startedAt = Date.now();
    recorder.onstop = async () => {
      const durationMs = Math.min(Date.now() - startedAt, MAX_CLIP_MS);
      releaseStream();
      const blob = new Blob(chunks, { type: 'video/mp4' });
      const previewUrl = URL.createObjectURL(blob);
      const { poster, width, height } = await capturePoster(previewUrl);
      setClip({ blob, poster, durationMs, width, height, previewUrl });
      setPhase('preview');
    };

    // A COACH STOPS ANY TIME; THE BROWSER STOPS AT 15 SECONDS. Sharing ended
    // from the browser's own "Stop sharing" bar also lands here, because the
    // track ending is what we listen for.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (recorder.state !== 'inactive') recorder.stop();
    });
    stopTimerRef.current = window.setTimeout(() => {
      if (recorder.state !== 'inactive') recorder.stop();
    }, MAX_CLIP_MS);
    tickRef.current = window.setInterval(
      () => setSeconds(elapsedSeconds(startedAt, Date.now())),
      250,
    );

    recorder.start();
    setSeconds(0);
    setPhase('recording');
  }

  function stop() {
    if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop();
  }

  function discard() {
    if (clip) URL.revokeObjectURL(clip.previewUrl);
    setClip(null);
    setSeconds(0);
    setPhase('idle');
  }

  if (!capability.supported) {
    return (
      <div className={styles.panel} role="note">
        <p className={styles.unsupported}>{UNSUPPORTED_MESSAGE}</p>
        <button type="button" className={nb.btnSecondary} onClick={onCancel}>
          Close
        </button>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {phase === 'idle' && (
        <>
          <p className={styles.hint}>
            Choose a window, tab or screen to record. Up to 15 seconds, no sound.
          </p>
          <div className={styles.actions}>
            <button type="button" className={nb.btnPrimary} onClick={() => void start()}>
              Start recording
            </button>
            <button type="button" className={nb.btnSecondary} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}

      {phase === 'recording' && (
        <>
          <p className={styles.recording} role="status">
            <span className={styles.dot} aria-hidden="true" />
            Recording · {String(seconds).padStart(2, '0')} / 15 sec
          </p>
          <div className={styles.actions}>
            <button type="button" className={nb.btnPrimary} onClick={stop}>
              Stop
            </button>
          </div>
        </>
      )}

      {phase === 'preview' && clip && (
        <>
          {/* The same four attributes the player will use, so what a coach
              approves here is what a player gets. */}
          <video
            className={styles.preview}
            src={clip.previewUrl}
            autoPlay
            loop
            muted
            playsInline
          />
          <div className={styles.actions}>
            <button type="button" className={nb.btnPrimary} onClick={() => onUse(clip)}>
              Use clip
            </button>
            <button type="button" className={nb.btnSecondary} onClick={discard}>
              Record again
            </button>
            <button type="button" className={nb.btnSecondary} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** One still frame, captured in the browser.
 *
 * Seeks a little in rather than taking frame zero: the first frame of a
 * screen capture is very often a blank paint, and a black poster is worse
 * than none. Degrades to a null poster rather than failing the recording -
 * every consumer already handles a clip without one.
 */
async function capturePoster(
  url: string,
): Promise<{ poster: Blob | null; width: number; height: number }> {
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('load failed'));
      window.setTimeout(() => reject(new Error('timeout')), 8000);
    });
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      try {
        video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
      } catch {
        resolve();
      }
      window.setTimeout(resolve, 3000);
    });
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(video, 0, 0, width, height);
    const poster = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', 0.72),
    );
    return { poster, width, height };
  } catch {
    return { poster: null, width: 0, height: 0 };
  }
}
