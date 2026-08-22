import { useCallback, useEffect, useState } from 'react';
import { getActiveStatus } from '../api/quizzes';
import type { ActiveQuizStatus } from '../api/types';
import { usePolling } from './usePolling';

/** How often the live board asks the server what players have done. */
export const ACTIVE_STATUS_POLL_MS = 15000;

/** The live state of every currently-active access code in the org.
 *
 * ONE POLL, TWO READERS. The dashboard shows this data twice - as the "Live
 * now" card and as the rail's activity feed, not-submitted count and
 * closing-soon list - and both want it fresh. Fetching it in each component
 * would double the request rate for one server round trip's worth of
 * information, so the dashboard owns the poll and hands the result to both.
 *
 * `null` means "never loaded successfully", which renders exactly like "no
 * quiz is active": nothing. That is deliberate. A background poll failing
 * must not blank out a board that was showing good data a moment ago, and it
 * must not raise an error banner over a widget that is not the only way to
 * reach any of this - so a failed tick keeps the last good state and lets the
 * next one try again.
 */
export function useActiveStatus(): ActiveQuizStatus[] | null {
  const [entries, setEntries] = useState<ActiveQuizStatus[] | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setEntries(await getActiveStatus());
    } catch {
      // Deliberately silent - see the note above.
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  usePolling(fetchStatus, ACTIVE_STATUS_POLL_MS);

  return entries;
}
