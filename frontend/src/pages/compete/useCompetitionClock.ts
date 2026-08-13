/**
 * The countdown, derived from SERVER time.
 *
 * WHY NOT JUST setInterval FROM A LOCAL START
 * --------------------------------------------
 * Because the phone's clock is not the competition's clock. A device minutes
 * off, or one that slept through half a question, would render a countdown
 * that disagrees with the projector and with the server that decides whether
 * an answer was in time. Everything here is computed from the two timestamps
 * the server issued plus the offset measured from `server_now`.
 *
 * A refresh therefore cannot restart a timer: there is no local start to
 * restart. Reconnecting mid-question shows exactly the time that is left.
 *
 * The lead-in falls out of the same arithmetic for free - `opensAt` is simply
 * in the future, which is why the 3-2-1 needed no server state of its own.
 */

import { useEffect, useMemo, useState } from 'react';

export interface CompetitionClock {
  /** Seconds until answering opens; 0 once it has. Drives the 3-2-1. */
  leadInRemaining: number;
  /** Seconds left to answer; 0 once the window has shut. */
  remaining: number;
  /** Whole seconds, for display. */
  remainingSeconds: number;
  /** 0 → 1 through the answering window, for a ring or bar. */
  progress: number;
  inLeadIn: boolean;
  expired: boolean;
}

const TICK_MS = 100;

export function useCompetitionClock(
  serverNow: string | null | undefined,
  opensAt: string | null | undefined,
  closesAt: string | null | undefined,
): CompetitionClock {
  const [, forceTick] = useState(0);

  /**
   * The gap between this device's clock and the server's, measured at the
   * moment each poll landed.
   *
   * Computed DURING RENDER rather than in an effect. An effect runs after the
   * first paint, so the very first frame following every poll would be drawn
   * with a stale offset - which is long enough to flash the wrong state, and
   * was caught by a lead-in test rendering a 3-2-1 that briefly wasn't there.
   */
  const offsetMs = useMemo(() => {
    if (!serverNow) return 0;
    const parsed = Date.parse(serverNow);
    return Number.isNaN(parsed) ? 0 : parsed - Date.now();
  }, [serverNow]);

  useEffect(() => {
    // Ticking locally between polls keeps the countdown smooth without asking
    // the server what time it is ten times a second.
    const timer = setInterval(() => forceTick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const now = Date.now() + offsetMs;
  const opens = opensAt ? Date.parse(opensAt) : NaN;
  const closes = closesAt ? Date.parse(closesAt) : NaN;

  if (Number.isNaN(opens) || Number.isNaN(closes)) {
    return {
      leadInRemaining: 0,
      remaining: 0,
      remainingSeconds: 0,
      progress: 0,
      inLeadIn: false,
      expired: false,
    };
  }

  const leadInRemaining = Math.max(0, (opens - now) / 1000);
  const remaining = Math.max(0, (closes - now) / 1000);
  const window = Math.max(1, (closes - opens) / 1000);

  return {
    leadInRemaining,
    remaining,
    // Ceil, so a player sees "1" for the whole final second rather than a
    // zero they still have time to beat.
    remainingSeconds: Math.ceil(remaining),
    progress: Math.min(1, Math.max(0, 1 - remaining / window)),
    inLeadIn: leadInRemaining > 0,
    expired: leadInRemaining <= 0 && remaining <= 0,
  };
}
