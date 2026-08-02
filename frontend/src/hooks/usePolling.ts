import { useEffect, useRef } from 'react';

/** Calls `fn` every `intervalMs` while mounted and `enabled`. Not a bare
 * `setInterval` in the component because four correctness properties are
 * each easy to get subtly wrong individually: a stale closure over `fn` if
 * the interval effect closed over the first render's callback, overlapping
 * requests piling up if one fetch is still in flight when the next tick
 * fires, a timer surviving unmount, and stale-looking data if a background
 * tab's ticks are silently skipped forever instead of catching up the
 * moment the coach looks back at it.
 *
 * No AbortController - api/client.ts's request() has no AbortSignal support
 * today, and plumbing that through for one polling widget is out of scope.
 * The in-flight guard (skip a tick if the previous call hasn't resolved)
 * is the right amount of engineering here instead. */
export function usePolling(fn: () => Promise<void>, intervalMs: number, enabled = true): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    async function tick() {
      if (document.hidden || inFlight.current) return;
      inFlight.current = true;
      try {
        await fnRef.current();
      } finally {
        inFlight.current = false;
      }
    }

    const id = setInterval(tick, intervalMs);
    // Returning to a background tab shouldn't leave the coach staring at
    // data that's been silently stale for however long it was hidden -
    // refresh immediately rather than waiting up to a full interval.
    function onVisibilityChange() {
      if (!document.hidden) tick();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs, enabled]);
}
