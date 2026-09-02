/** Stopping a clip on the frame a coach chose.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT
 * ---------------------------------------------------------------------------
 *
 * THE VIDEO MUST NOT RUN THROUGH THE DECISION POINT. Everything here follows
 * from that one sentence. Football recognition is tested before the outcome
 * exists - identify the coverage, the fit, the leverage - and a clip that
 * plays on to the whistle answers its own question. Overshooting by a few
 * frames is untidy; overshooting by half a second can show the throw.
 *
 * ---------------------------------------------------------------------------
 * WHY FOUR MECHANISMS AND NOT ONE
 * ---------------------------------------------------------------------------
 *
 * MEASURED, NOT REASONED. A Phase 0 harness ran this on a real iPhone:
 *
 *     10 / 10 attempts stopped in time, MAXIMUM overshoot 41ms
 *     (acceptance threshold was 100ms MAX, not average)
 *
 * That is the evidence this file is built on, and it is the only device
 * evidence we have - no broader Safari or Android claim is implied.
 *
 * The same harness also caught the failure that shaped the design. In a
 * browser tab that was not being composited, `requestVideoFrameCallback` and
 * `requestAnimationFrame` BOTH went silent and the clip played to its very
 * end, every attempt. Both are display-driven: they stop existing exactly
 * when the tab stops being painted, and the video may keep playing anyway.
 * A decision point built on either alone fails by revealing the whole play,
 * which is the worst thing this feature can do.
 *
 * So precision and guarantee come from different places:
 *
 *   requestVideoFrameCallback  frame-accurate, fires per presented frame
 *   requestAnimationFrame      ~16ms, also display-driven
 *   timeupdate                 from the MEDIA pipeline, not the compositor
 *   a timer                    cares about neither
 *
 * The first two are the precision. The last two are the floor: far too coarse
 * to stop on the right frame - `timeupdate` is roughly 250ms on Safari - but
 * they turn "the entire play leaked" into "a few frames overshot".
 *
 * ---------------------------------------------------------------------------
 * AND IT CORRECTS ITSELF
 * ---------------------------------------------------------------------------
 *
 * Whichever mechanism fires first pauses the video AND seeks back to the
 * decision point if playback got past it. A stop that lands late still holds
 * the frame the coach chose, so the overshoot costs nothing a player can see.
 */

/** How far past the decision point counts as needing a corrective seek.
 *  Below this the pause landed on the intended frame anyway, and seeking
 *  would only make the picture twitch for no gain. */
const SEEK_BACK_TOLERANCE_SEC = 0.02;

/** Slack on the timer backstop, so it is genuinely a floor rather than a
 *  competitor: it should fire only when the display-driven mechanisms have
 *  already failed to. */
const TIMER_SLACK_MS = 60;

export interface DecisionPointStop {
  /** Where playback actually came to rest, in seconds. */
  stoppedAt: number;
  /** Which mechanism got there first - useful in a bug report, never in a UI. */
  stoppedBy: 'rvfc' | 'raf' | 'timeupdate' | 'timer' | 'ended';
}

type VideoLike = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
};

/** Arms every stopper on `video` for `decisionPointSec`. Returns a disarm
 *  function; calling it twice is safe, and so is disarming after the stop.
 *
 *  `onStop` runs exactly once. */
export function armDecisionPointStop(
  video: HTMLVideoElement,
  decisionPointSec: number,
  onStop: (stop: DecisionPointStop) => void,
): () => void {
  const el = video as VideoLike;
  let finished = false;
  let rafId: number | null = null;
  let timerId: number | null = null;

  function cleanup() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (timerId !== null) clearTimeout(timerId);
    rafId = null;
    timerId = null;
    el.removeEventListener('timeupdate', onTimeUpdate);
    el.removeEventListener('ended', onEnded);
  }

  function stop(stoppedBy: DecisionPointStop['stoppedBy']) {
    if (finished) return;
    finished = true;
    cleanup();
    try {
      el.pause();
      // THE SELF-CORRECTION. A late stop still holds the coach's frame.
      if (el.currentTime > decisionPointSec + SEEK_BACK_TOLERANCE_SEC) {
        el.currentTime = decisionPointSec;
      }
    } catch {
      // A detached or torn-down element. Nothing is playing, so the invariant
      // holds regardless; there is nothing useful to report.
    }
    onStop({ stoppedAt: el.currentTime, stoppedBy });
  }

  function onTimeUpdate() {
    if (el.currentTime >= decisionPointSec) stop('timeupdate');
  }

  function onEnded() {
    // Reaching the end means everything above missed. Reported honestly rather
    // than swallowed - a caller that sees this knows the play was revealed.
    stop('ended');
  }

  el.addEventListener('timeupdate', onTimeUpdate);
  el.addEventListener('ended', onEnded);

  if (typeof el.requestVideoFrameCallback === 'function') {
    const frame = () => {
      if (finished) return;
      el.requestVideoFrameCallback!((_now, meta) => {
        if (finished) return;
        if (meta.mediaTime >= decisionPointSec) return stop('rvfc');
        frame();
      });
    };
    frame();
  }

  const poll = () => {
    if (finished) return;
    if (el.currentTime >= decisionPointSec) return stop('raf');
    rafId = requestAnimationFrame(poll);
  };
  poll();

  const remainingMs = Math.max(0, (decisionPointSec - el.currentTime) * 1000);
  timerId = window.setTimeout(() => {
    if (!finished && el.currentTime >= decisionPointSec - 0.05) stop('timer');
  }, remainingMs + TIMER_SLACK_MS);

  return () => {
    finished = true;
    cleanup();
  };
}

/** Milliseconds to seconds, refusing anything that is not a usable point.
 *
 *  A clip whose decision point is absent, zero or nonsense is an ORDINARY
 *  clip - the same meaning NULL carries in the database - so this returns null
 *  rather than throwing. Presentation must never fail closed into an error
 *  screen when the honest answer is "this one just loops". */
export function decisionPointSeconds(ms: number | null | undefined): number | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return ms / 1000;
}
