import { useCallback, useEffect, useState } from 'react';
import { getWhatsNew, markWhatsNewSeen } from '../../api/whatsNew';
import { LATEST_RELEASE_ID, hasUnreadReleases } from './releases';

interface WhatsNewHook {
  hasUnread: boolean;
  /** Called when the coach opens What's New. Clears the indicator locally at
   *  once and records the newest release id on the server. */
  markSeen: () => void;
}

/** Unread state for What's New.
 *
 *  Fetched once when the Help menu mounts - it is one small request on a
 *  page a coach was loading anyway, and it has to come from the server for
 *  the read state to follow them between devices.
 *
 *  Fails closed: if the request errors, `hasUnread` stays false. A dot that
 *  will not go away because the network hiccuped is worse than a dot that
 *  never appears, and the release notes are still reachable from the menu
 *  either way.
 */
export function useWhatsNew(): WhatsNewHook {
  const [hasUnread, setHasUnread] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getWhatsNew()
      .then((state) => {
        if (!cancelled) setHasUnread(hasUnreadReleases(state.seen_version));
      })
      .catch(() => {
        if (!cancelled) setHasUnread(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const markSeen = useCallback(() => {
    // Cleared locally first so the dot disappears on the click rather than
    // after the round trip. If the request fails the dot returns on the next
    // load, which is the right way round: the coach did read the notes, and
    // the worst case is being told about them again.
    setHasUnread(false);
    markWhatsNewSeen(LATEST_RELEASE_ID).catch(() => {});
  }, []);

  return { hasUnread, markSeen };
}
