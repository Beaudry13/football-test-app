import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './ClipPlayer.module.css';
import { armDecisionPointStop, decisionPointSeconds } from './decisionPoint';

/** A recorded clip, rendered the way a GIF reads.
 *
 * The four attributes are not decoration and none is optional:
 *
 *   autoplay     starts without a tap
 *   loop         repeats forever
 *   muted        REQUIRED, or autoplay is blocked on every browser
 *   playsinline  REQUIRED, or iOS takes the video fullscreen mid-quiz
 *
 * Dropping `muted` or `playsinline` breaks playback on exactly the devices
 * players use, and would never fail a test that only checked a <video>
 * rendered - which is why there is a test asserting all four.
 *
 * A CLIP THAT WILL NOT PLAY FALLS BACK TO ITS POSTER, not to a black box. The
 * still frame is real football material and is worth showing on its own; the
 * caption says the motion is missing rather than letting a coach or player
 * conclude the question is broken.
 *
 * ---------------------------------------------------------------------------
 * ONE TAP, AND WHY IT IS NOT A CONTROLS BAR
 * ---------------------------------------------------------------------------
 *
 * `controls={false}` with nothing else meant a paused clip was a DEAD END. It
 * paused for reasons the player did not choose and could not undo: iOS blocks
 * muted autoplay in Low Power Mode, and Safari pauses video when the tab goes
 * to the background and does not resume it on return. In both cases the
 * question showed a frozen frame with no affordance of any kind - no button,
 * no gesture, nothing to discover.
 *
 * So the whole surface is one button: tap or press to pause, tap or press to
 * resume. Not a scrubber and not a controls bar - a fifteen-second silent loop
 * has nothing to scrub, and a timeline would invite a player to treat the
 * football as a video to browse rather than as the thing the question is
 * asking about. It also earns its place twice, because a coach's player often
 * WANTS to freeze on the formation.
 *
 * The play glyph appears only while paused. A clip that is doing its job
 * carries no chrome at all.
 *
 * NATIVE `loop` IS UNTOUCHED for an ordinary clip. The looping is still the
 * browser's, so nothing here can drift, stutter or double-fire at the loop
 * point.
 *
 * ---------------------------------------------------------------------------
 * A DECISION-POINT CLIP IS THE SAME COMPONENT IN A DIFFERENT MODE
 * ---------------------------------------------------------------------------
 *
 * With `decisionPointMs` the film stops on the frame the coach chose and holds
 * it: no looping, because a pre-snap sequence repeating every few seconds
 * while a player is trying to read it is a distraction rather than a help.
 * Replay puts it back to the start; See the rest is offered only once an
 * answer exists, and plays the remainder once.
 *
 * `autostart={false}` covers the single-page quiz, where every clip on screen
 * would otherwise begin at once.
 *
 * NOT A SECOND COMPONENT, because the two must never disagree about scale,
 * position or fallback - the same reason the coach and the player share this
 * one today. An ordinary clip takes none of these branches.
 */
export function ClipPlayer({
  url,
  posterUrl,
  className,
  ariaLabel,
  decisionPointMs,
  canReveal = false,
  autostart = true,
}: {
  url: string;
  posterUrl?: string | null;
  className?: string;
  ariaLabel?: string;
  /** Where the film stops so the player can decide. Absent or null is an
   *  ordinary clip and every decision-point branch below is skipped. */
  decisionPointMs?: number | null;
  /** Whether "See the rest" is offered. THE TRIGGER IS THAT AN ANSWER
   *  EXISTS, never that it is correct - revealing the play is not revealing
   *  the answer, and this component is given no way to tell the difference. */
  canReveal?: boolean;
  /** False on a single-page quiz, where a screen of clips would otherwise
   *  all start playing at once. */
  autostart?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [paused, setPaused] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const stopAt = decisionPointSeconds(decisionPointMs);
  const isDecisionPoint = stopAt !== null;
  /** 'holding' - stopped on the coach's frame, waiting for an answer.
   *  'revealed' - the player asked for the rest and it is playing out. */
  const [phase, setPhase] = useState<'holding' | 'revealed'>('holding');
  const disarmRef = useRef<(() => void) | null>(null);

  /** Plays from `from` with the stop armed BEFORE playback begins.
   *
   *  Arming first is not a detail: arming after `play()` leaves a window in
   *  which the film is running with nothing watching it, and on a short clip
   *  that window can contain the decision point. */
  const playGuarded = useCallback(
    (from: number) => {
      const el = videoRef.current;
      if (!el || stopAt === null) return;
      disarmRef.current?.();
      try {
        el.currentTime = from;
      } catch {
        // Metadata not ready yet; playback still starts from the beginning,
        // which is the only value `from` ever takes before it is.
      }
      disarmRef.current = armDecisionPointStop(el, stopAt, () => {
        disarmRef.current = null;
      });
      const attempt = el.play();
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch(() => setPaused(true));
      }
    },
    [stopAt],
  );

  const replay = useCallback(() => {
    setPhase('holding');
    playGuarded(0);
  }, [playGuarded]);

  /** THE REMAINDER, ONCE. No stopper is armed - this is the part the player
   *  has earned by answering - and no loop, because re-watching the outcome
   *  is the least instructive thing on offer. */
  const reveal = useCallback(() => {
    const el = videoRef.current;
    if (!el || stopAt === null) return;
    disarmRef.current?.();
    disarmRef.current = null;
    setPhase('revealed');
    try {
      el.currentTime = stopAt;
    } catch {
      /* If the seek is refused the film simply continues from where it is. */
    }
    const attempt = el.play();
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(() => setPaused(true));
    }
  }, [stopAt]);

  useEffect(() => () => disarmRef.current?.(), []);

  /** Autoplay is a REQUEST, not a guarantee.
   *
   *  `play()` returns a promise that rejects when the browser declines - Low
   *  Power Mode is the common one. Nothing was listening for that rejection,
   *  so a declined autoplay looked identical to a clip that had simply not
   *  started yet. Catching it is what turns an invisible refusal into a
   *  visible play button. */
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!autostart) {
      // A single-page quiz. Nothing plays until the player asks, so the page
      // does not become a wall of simultaneous film.
      setPaused(true);
      return;
    }
    if (stopAt !== null) {
      playGuarded(0);
      return;
    }
    const attempt = el.play();
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(() => setPaused(true));
    }
  }, [url, autostart, stopAt, playGuarded]);

  const toggle = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    // Reads the ELEMENT rather than React state, so repeated taps cannot get
    // out of step with what the video is actually doing.
    if (el.paused) {
      // A TAP MUST NEVER BE A WAY PAST THE DECISION POINT. Resuming a clip
      // that is being held on the coach's frame would play straight into the
      // outcome, so while holding, the tap restarts the run-up instead.
      if (stopAt !== null && phase === 'holding') {
        if (el.currentTime >= stopAt - 0.05) replay();
        else playGuarded(el.currentTime);
        return;
      }
      const attempt = el.play();
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch(() => setPaused(true));
      }
    } else {
      el.pause();
    }
  }, [stopAt, phase, replay, playGuarded]);

  if (failed) {
    return (
      <div>
        {posterUrl ? (
          /* A REAL ALT, not an empty one. Beside a working video the poster is
             decorative - the video carries the meaning. Here it is the only
             thing conveying the football, so it has to describe itself. */
          <img
            className={styles.fallback}
            src={posterUrl}
            alt={ariaLabel ?? 'Still frame from the recorded clip'}
          />
        ) : null}
        <p className={styles.fallbackNote}>
          This clip could not play here{posterUrl ? ' - showing a still frame.' : '.'}
        </p>
      </div>
    );
  }

  const surface = (
    /* A BUTTON WRAPPING THE VIDEO, rather than a click handler on the video.
       A <video> without controls is not focusable and not reachable by
       keyboard at all, so a bare onClick would have been a mouse-and-touch
       only feature. A real button gets Enter and Space, a visible focus ring
       and an accessible name for free - and a controls-less video counts as
       non-interactive content, so nesting it here is legitimate. */
    <button
      type="button"
      /* The caller's class stays on the VIDEO, where it has always been.
         Moving it up here looked tidier and was wrong: the play surface
         carries `max-height: 82dvh`, which constrains a tall clip when it is
         on the video and CROPS one when it is on a clipping wrapper. */
      className={styles.surface}
      onClick={toggle}
      aria-label={paused ? 'Play the clip' : 'Pause the clip'}
    >
      <video
        ref={videoRef}
        className={`${styles.clip} ${className ?? ''}`}
        src={url}
        poster={posterUrl ?? undefined}
        // Autoplay is a REQUEST; the effect above catches a refusal. Off
        // entirely on a single-page quiz.
        autoPlay={autostart}
        // NO NATIVE LOOP on a decision-point clip: looping the run-up every
        // few seconds while a player is trying to read it is a distraction,
        // and after the reveal, re-watching the outcome teaches nothing.
        loop={!isDecisionPoint}
        muted
        playsInline
        // No controls bar: a fifteen-second silent loop has nothing to
        // scrub, and a timeline would invite a player to treat it as a video
        // rather than as the material the question is about. The wrapping
        // button is the entire interface.
        controls={false}
        // The button carries the accessible name, so announcing the video
        // separately would read the same clip twice.
        aria-hidden="true"
        onPlay={() => setPaused(false)}
        // Fires for a background tab too, which is exactly the case that used
        // to strand a player on a frozen frame.
        onPause={() => setPaused(true)}
        onError={() => setFailed(true)}
      />
      {paused && (
        /* THE ONLY CHROME, and only when it means something. A player looking
           at a still frame has to be told it is not simply a photograph. */
        <span className={styles.playBadge} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="28" height="28" focusable="false">
            <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
          </svg>
        </span>
      )}
    </button>
  );

  if (!isDecisionPoint) return surface;

  return (
    <div className={styles.decision}>
      {surface}
      <div className={styles.decisionActions}>
        <button type="button" className={styles.decisionBtn} onClick={replay}>
          Replay
        </button>
        {/* OFFERED ONLY ONCE AN ANSWER EXISTS. Not once it is right - the
            component is never told whether it is, so it cannot become a
            correctness signal by accident. */}
        {phase === 'holding' && canReveal && (
          <button type="button" className={styles.decisionBtn} onClick={reveal}>
            See the rest
          </button>
        )}
      </div>
      {phase === 'holding' && !canReveal && (
        <p className={styles.decisionNote}>
          The film stops here. Answer the question to see the rest of the play.
        </p>
      )}
    </div>
  );
}

/** The still frame alone, for surfaces where motion would be noise.
 *
 * A coach's question list can hold twenty questions; twenty simultaneously
 * looping videos is real decoding work for no benefit, since the list is
 * scanned rather than watched. */
export function ClipThumbnail({
  posterUrl,
  className,
  alt = '',
}: {
  posterUrl: string | null | undefined;
  className?: string;
  alt?: string;
}) {
  if (!posterUrl) return null;
  return <img className={className} src={posterUrl} alt={alt} loading="lazy" />;
}
