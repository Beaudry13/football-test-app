import { useRef, useState } from 'react';
import nb from '../../styles/notebook.module.css';
import styles from './DecisionPointEditor.module.css';
import { ClipPlayer } from './ClipPlayer';
import { formatClipDuration } from './clipRecording';

/** Choosing the frame the film stops on.
 *
 * PAUSE ON THE FOOTBALL, NOT ON A TIMELINE. A coach picks this moment by
 * watching the play and stopping where the decision is - at the snap, on the
 * pull, as the receiver releases. So the control is the video itself: play it,
 * pause on the frame, press Set decision point, and the current time is taken
 * from the element the coach is looking at.
 *
 * A scrubber was deliberately not built. It would be no more accurate than the
 * frame already on screen, and it invites treating football film as a timeline
 * to edit rather than a moment to choose.
 *
 * PREVIEW AS PLAYER IS THE OTHER HALF, and it matters more than it looks. The
 * whole feature is a claim about what a player CANNOT see, and a coach must be
 * able to check that claim before assigning the quiz. So preview runs the real
 * player component in its real decision-point mode - not a coach-side
 * imitation that could agree with the editor while disagreeing with the quiz.
 */
export function DecisionPointEditor({
  url,
  posterUrl,
  decisionPointMs,
  durationMs,
  onChange,
  busy = false,
}: {
  url: string;
  posterUrl?: string | null;
  decisionPointMs: number | null;
  durationMs?: number | null;
  onChange: (ms: number | null) => void;
  busy?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setFromCurrentFrame() {
    // The coach's own video element, read at the instant they press. Queried
    // rather than held in state so it cannot drift from what is on screen.
    const el = videoRef.current ?? document.querySelector<HTMLVideoElement>('video');
    if (!el) return;
    const ms = Math.round(el.currentTime * 1000);
    if (ms <= 0) {
      setError('Play the clip and pause on the moment you want it to stop.');
      return;
    }
    if (durationMs && ms >= durationMs) {
      setError('Pick a moment before the end of the clip.');
      return;
    }
    setError(null);
    onChange(ms);
  }

  if (previewing) {
    return (
      <div className={styles.panel}>
        <p className={styles.hint}>
          This is exactly what a player sees before they answer.
        </p>
        {/* The real component in its real mode. `canReveal` is false because a
            player has not answered yet at this point in the quiz. */}
        <ClipPlayer
          url={url}
          posterUrl={posterUrl}
          decisionPointMs={decisionPointMs}
          canReveal={false}
          ariaLabel="Preview of the clip as a player sees it"
        />
        <div className={styles.actions}>
          <button
            type="button"
            className={nb.btnSecondary}
            onClick={() => setPreviewing(false)}
          >
            Back to editing
          </button>
        </div>
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

      {/* A plain element, not ClipPlayer: here the coach needs ordinary
          scrubbing-free play and pause over the WHOLE clip, including the part
          a player will not see. Handing them the player component would stop
          the film at the very point they are trying to choose. */}
      <video
        ref={videoRef}
        className={styles.video}
        src={url}
        poster={posterUrl ?? undefined}
        controls
        muted
        playsInline
        preload="metadata"
      />

      <p className={styles.state}>
        {decisionPointMs
          ? `Freezes at ${formatClipDuration(decisionPointMs)}`
          : 'Plays the whole clip on a loop.'}
      </p>

      <div className={styles.actions}>
        <button
          type="button"
          className={nb.btnPrimary}
          onClick={setFromCurrentFrame}
          disabled={busy}
        >
          {decisionPointMs ? 'Change decision point' : 'Set decision point'}
        </button>
        {decisionPointMs != null && (
          <>
            <button
              type="button"
              className={nb.btnSecondary}
              onClick={() => setPreviewing(true)}
              disabled={busy}
            >
              Preview as player
            </button>
            <button
              type="button"
              className={nb.btnSecondary}
              onClick={() => {
                setError(null);
                onChange(null);
              }}
              disabled={busy}
            >
              Clear
            </button>
          </>
        )}
      </div>

      <p className={styles.hint}>
        Play the clip and pause on the moment the player has to decide, then set
        it. The film stops there until they answer.
      </p>
    </div>
  );
}
