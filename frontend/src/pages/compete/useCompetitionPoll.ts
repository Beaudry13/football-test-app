/**
 * The versioned polling loop, shared by the host and every player.
 *
 * THE CONTRACT IT IMPLEMENTS
 * ---------------------------
 * Poll the cheap five-field state endpoint about once a second. Fetch the
 * heavy payload - roster, participants - only when `version` changes, plus
 * once on mount. That split is the entire reason the backend has a `version`
 * column, and putting the heavy fetch on the timer instead would undo it.
 *
 * SELF-CORRECTING INTERVAL, NOT setInterval
 * ------------------------------------------
 * setInterval queues another call whether or not the last one finished. On a
 * bad connection that turns one phone into a backlog of overlapping requests -
 * exactly the stampede this is supposed to avoid. Each cycle is scheduled
 * after the previous one settles.
 *
 * BACKOFF THAT RECOVERS
 * ----------------------
 * A transient failure must not white-screen a competition, and must not turn
 * 1 Hz into a retry storm. Consecutive failures back off 1s -> 2s -> 4s ->
 * 8s (capped), and the first success returns to 1 Hz immediately. The last
 * good state stays on screen throughout: a player looking at their name does
 * not want it replaced by an error because one poll timed out.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../../api/client';
import type { CompetitionPollState } from '../../api/competition';

const BASE_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 8000;

/**
 * A tighter backoff ceiling for the states where seconds matter.
 *
 * 8s is fine in a lobby - nothing is happening and a slow recovery costs
 * nobody anything. During a live question it is a disaster: a phone that hit
 * two failures could sit eight seconds behind a twenty-second countdown, and
 * discover the question had closed while it was still showing time remaining.
 */
const LIVE_MAX_INTERVAL_MS = 2000;
const LIVE_STATUSES = ['QUESTION_OPEN', 'QUESTION_REVEAL'];

/**
 * Floor between two heavy fetches on one client.
 *
 * THE STAMPEDE THIS PREVENTS, with real numbers. Thirty players joining a
 * lobby bump the version thirty times. Every connected client sees each bump,
 * so a naive "fetch on every change" is 30 x 30 = 900 roster fetches during
 * the join window - about 1800/min against one session, which measurably
 * rate-limited itself in the load harness.
 *
 * Coalescing to one fetch per 2s per client roughly halves that, and more
 * importantly makes it independent of how fast people are arriving: a burst of
 * ten joins in one second produces one fetch, not ten. The final state is
 * never lost - a change arriving inside the window sets a dirty flag and
 * fetches when the window closes, so the roster always converges.
 */
const HEAVY_FETCH_MIN_INTERVAL_MS = 2000;

export interface CompetitionPollOptions {
  /** The cheap five-field poll. */
  poll: () => Promise<CompetitionPollState>;
  /** The heavy fetch, run on mount and on every version change. */
  onVersionChange?: (state: CompetitionPollState) => void | Promise<void>;
  /**
   * A poll that failed in a way retrying cannot fix - a 404 for a deleted
   * session, a 410 for an expired one. Polling STOPS; the caller decides what
   * to show. Without this the loop would hammer a dead code forever.
   */
  onFatal?: (error: ApiError) => void;
  enabled?: boolean;
}

export interface CompetitionPollResult {
  state: CompetitionPollState | null;
  /** True only after repeated failures - one blip should not alarm anyone. */
  degraded: boolean;
  /** Force an immediate cycle, e.g. after the coach removes a participant. */
  refresh: () => void;
}

/** Statuses that mean "stop polling"; retrying cannot change any of them. */
function isFatal(error: unknown): error is ApiError {
  return error instanceof ApiError && [404, 410].includes(error.status);
}

export function useCompetitionPoll({
  poll,
  onVersionChange,
  onFatal,
  enabled = true,
}: CompetitionPollOptions): CompetitionPollResult {
  const [state, setState] = useState<CompetitionPollState | null>(null);
  const [degraded, setDegraded] = useState(false);

  // Refs, not state: these change on every cycle and must not re-render or
  // re-create the loop. A dependency on any of them would restart polling
  // constantly, which is its own request storm.
  const lastVersion = useRef<number | null>(null);
  const failures = useRef(0);
  const lastHeavyFetch = useRef(0);
  const heavyPending = useRef<CompetitionPollState | null>(null);
  const heavyInFlight = useRef(false);
  const liveStatus = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);
  const wake = useRef<(() => void) | null>(null);

  // The callbacks are read through refs so a caller passing an inline arrow
  // function - which every caller does - does not restart the loop each render.
  const pollRef = useRef(poll);
  const versionRef = useRef(onVersionChange);
  const fatalRef = useRef(onFatal);
  pollRef.current = poll;
  versionRef.current = onVersionChange;
  fatalRef.current = onFatal;

  useEffect(() => {
    if (!enabled) return;
    stopped.current = false;
    lastVersion.current = null;
    failures.current = 0;
    lastHeavyFetch.current = 0;
    heavyPending.current = null;
    heavyInFlight.current = false;

    let cancelled = false;

    const cycle = async () => {
      if (cancelled || stopped.current) return;
      try {
        const next = await pollRef.current();
        if (cancelled || stopped.current) return;

        failures.current = 0;
        setDegraded(false);
        setState(next);
        liveStatus.current = LIVE_STATUSES.includes(next.status);

        // Mount (null) or a real change. Never on every tick.
        if (lastVersion.current === null || next.version !== lastVersion.current) {
          lastVersion.current = next.version;
          heavyPending.current = next;
        }

        // Drain the pending heavy fetch, at most one per window and never two
        // at once. `heavyPending` holds the LATEST state, so a burst collapses
        // into a single fetch of the newest version rather than a queue.
        const sinceLast = performance.now() - lastHeavyFetch.current;
        if (
          heavyPending.current &&
          !heavyInFlight.current &&
          (lastHeavyFetch.current === 0 || sinceLast >= HEAVY_FETCH_MIN_INTERVAL_MS)
        ) {
          const pending = heavyPending.current;
          heavyPending.current = null;
          heavyInFlight.current = true;
          lastHeavyFetch.current = performance.now();
          try {
            await versionRef.current?.(pending);
          } finally {
            heavyInFlight.current = false;
          }
        }
      } catch (error) {
        if (cancelled || stopped.current) return;

        if (isFatal(error)) {
          // Nothing to retry. Stop and let the screen explain itself.
          stopped.current = true;
          fatalRef.current?.(error as ApiError);
          return;
        }
        failures.current += 1;
        // Two consecutive failures before saying anything: a single dropped
        // request on a phone is normal and not worth a banner.
        if (failures.current >= 2) setDegraded(true);
      }

      if (cancelled || stopped.current) return;
      const live = liveStatus.current;
      const delay = Math.min(
        BASE_INTERVAL_MS * 2 ** Math.max(0, failures.current - 1),
        live ? LIVE_MAX_INTERVAL_MS : MAX_INTERVAL_MS,
      );
      timer.current = setTimeout(cycle, delay);
    };

    wake.current = () => {
      if (timer.current) clearTimeout(timer.current);
      void cycle();
    };
    void cycle();

    /**
     * A phone that slept through part of a question wakes holding a stale
     * countdown and a stale state. Waiting up to a second to find out is the
     * difference between answering and missing the round, so poll the instant
     * the tab becomes visible again.
     */
    const onVisible = () => {
      if (document.visibilityState === 'visible') wake.current?.();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      wake.current = null;
      document.removeEventListener('visibilitychange', onVisible);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled]);

  const refresh = useCallback(() => {
    wake.current?.();
  }, []);

  return { state, degraded, refresh };
}
