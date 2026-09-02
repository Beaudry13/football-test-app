import { useCallback, useEffect, useRef, useState } from 'react';
import nb from '../../styles/notebook.module.css';
import styles from './ClipRecorder.module.css';
import {
  DISPLAY_MEDIA_CONSTRAINTS,
  MAX_CLIP_MS,
  UNSUPPORTED_MESSAGE,
  detectClipCapability,
  elapsedSeconds,
  formatClipDuration,
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
 * A TOOL, NOT AN APPLICATION. Choose, start, stop, look at it, keep it or
 * throw it away. No timeline, no trimming, no crop - the browser's own picker
 * already crops by letting a coach choose one window or tab, at the operating-
 * system level, before a single frame is encoded.
 *
 * CHOOSING A SOURCE IS NOT CONSENT TO RECORD. The picker and the clock are two
 * decisions, and they used to be one: choosing a window started the recorder
 * on the same click, so the whole budget was spent finding the film,
 * moving the mouse out of shot and getting to the right frame. A coach cannot
 * arrange a window that is already being recorded. READY exists so the
 * expensive, irreversible thing - the clock - waits for its own deliberate
 * press.
 *
 * FAILS BEFORE RECORDING, NEVER AFTER. Capability is checked up front, and a
 * browser that cannot produce MP4 gets a message instead of a button. The
 * alternative - record, then discover at save time - would waste the coach's
 * take and leave them with nothing.
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

  const [phase, setPhase] = useState<'idle' | 'ready' | 'recording' | 'preview'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [clip, setClip] = useState<RecordedClip | null>(null);
  /** A COMPLETED TAKE IS EXPENSIVE TO REPLACE, so throwing one away is a two
   *  step action. Not a browser confirm(): re-recording is an ordinary thing
   *  a coach does often, and a modal alert for a routine action trains people
   *  to dismiss alerts without reading them. An inline second press asks the
   *  question exactly where the mistake would happen and costs nothing to
   *  back out of. */
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const stopTimerRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);
  const liveRef = useRef<HTMLVideoElement | null>(null);
  /** The `ended` listener is attached once, when the share is granted, but has
   *  to behave differently depending on what we are doing with that share. A
   *  ref rather than the state value because the listener closes over its
   *  creation-time scope and would otherwise read a stale phase forever. */
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

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

  /** Shows the granted share back to the coach while they arrange it.
   *
   *  `srcObject` cannot be set as a JSX prop - React only assigns attributes,
   *  and a MediaStream is not one - so it is attached here and detached when
   *  the element goes away. Muted is not cosmetic: an unmuted live preview of
   *  a tab that is playing audio feeds back through the speakers.  */
  useEffect(() => {
    const el = liveRef.current;
    if (!el) return;
    el.srcObject = streamRef.current;
    return () => {
      el.srcObject = null;
    };
  }, [phase]);

  /** Step one: get the share. Deliberately does NOT touch MediaRecorder. */
  async function chooseSource() {
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
    setSeconds(0);

    // ENDING THE SHARE FROM THE BROWSER'S OWN BAR, in either state. While
    // recording it is a stop and the take is kept, which is the behaviour that
    // already existed. While merely ready there is nothing to keep, so it
    // returns to the start rather than leaving a dead preview on screen.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (phaseRef.current === 'recording') {
        if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop();
        return;
      }
      releaseStream();
      setPhase('idle');
    });

    setPhase('ready');
  }

  /** Step two, and the only place the clock starts. */
  function beginRecording() {
    const stream = streamRef.current;
    if (!stream || !capability.mimeType) return;

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

    // A COACH STOPS ANY TIME; THE BROWSER STOPS AT THE CAP.
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

  /** Cancelling a share that has not recorded anything.
   *
   *  Releases the tracks rather than just changing screens: the coach is still
   *  visibly sharing until the tracks stop, and a UI that has moved on while
   *  the operating system says otherwise is the alarming case. Returns to the
   *  start so a different window can be chosen without reopening the recorder.
   */
  function cancelReady() {
    releaseStream();
    setSeconds(0);
    setPhase('idle');
  }

  function discard() {
    if (clip) URL.revokeObjectURL(clip.previewUrl);
    setClip(null);
    setSeconds(0);
    setConfirmingDiscard(false);
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
            Choose a window, tab or screen. Nothing records until you press Start
            recording. Up to 20 seconds, no sound.
          </p>
          <div className={styles.actions}>
            <button type="button" className={nb.btnPrimary} onClick={() => void chooseSource()}>
              Choose what to record
            </button>
            <button type="button" className={nb.btnSecondary} onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}

      {phase === 'ready' && (
        <>
          {/* Muted, and never `loop` - this is a live mirror of the share, not
              a clip. Autoplay is safe because the stream carries no audio. */}
          <video className={styles.preview} ref={liveRef} autoPlay muted playsInline />
          {/* THE WHOLE POINT OF THIS STATE, said plainly. The browser is
              already showing its own sharing indicator, so a coach who is told
              only "sharing" will reasonably assume the clock is running. */}
          <p className={styles.ready} role="status">
            <span className={styles.readyDot} aria-hidden="true" />
            Your screen is shared, but nothing is being recorded yet. Arrange the
            window, then press Start recording.
          </p>
          <div className={styles.actions}>
            <button type="button" className={nb.btnPrimary} onClick={beginRecording}>
              Start recording
            </button>
            <button type="button" className={nb.btnSecondary} onClick={cancelReady}>
              Cancel
            </button>
          </div>
        </>
      )}

      {phase === 'recording' && (
        <>
          <video className={styles.preview} ref={liveRef} autoPlay muted playsInline />
          <p className={styles.recording} role="status">
            <span className={styles.dot} aria-hidden="true" />
            Recording · {String(seconds).padStart(2, '0')} / 20 sec
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
          {/* HOW LONG THE TAKE IS, which the coach otherwise had no way to
              know - the recorder captured `durationMs` and showed it nowhere,
              so a six second take and a fourteen second one looked identical.
              A single line of text rather than a scrubber: this answers "did
              I get it", not "let me edit it". */}
          {formatClipDuration(clip.durationMs) && (
            <p className={styles.takeLength}>{formatClipDuration(clip.durationMs)}</p>
          )}
          {confirmingDiscard ? (
            <>
              <p className={styles.confirm} role="status">
                Record again? This take will be thrown away.
              </p>
              <div className={styles.actions}>
                {/* KEEPING IS THE DEFAULT-LOOKING CHOICE. The destructive
                    option must not be the one a coach hits by reflex twice. */}
                <button
                  type="button"
                  className={nb.btnPrimary}
                  onClick={() => setConfirmingDiscard(false)}
                >
                  Keep clip
                </button>
                <button type="button" className={nb.btnSecondary} onClick={discard}>
                  Record again
                </button>
              </div>
            </>
          ) : (
            <div className={styles.actions}>
              <button type="button" className={nb.btnPrimary} onClick={() => onUse(clip)}>
                Use clip
              </button>
              <button
                type="button"
                className={nb.btnSecondary}
                onClick={() => setConfirmingDiscard(true)}
              >
                Record again
              </button>
              <button type="button" className={nb.btnSecondary} onClick={onCancel}>
                Cancel
              </button>
            </div>
          )}
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
