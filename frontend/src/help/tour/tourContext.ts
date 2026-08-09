import { createContext, useContext } from 'react';

export interface TourValue {
  /** Launch the Dashboard Tour. Always manual - nothing auto-starts it. */
  start: () => void;
  active: boolean;
}

/** Split from TourProvider deliberately: a module that exports both a
 *  component and a hook breaks React Fast Refresh, which oxlint flags. The
 *  context and its hook live here; the component lives next door. */
export const TourContext = createContext<TourValue | null>(null);

/** Throws when there is no provider, deliberately.
 *
 *  A no-op fallback would turn a missing provider into a Help entry that
 *  silently does nothing - the exact dead-button behaviour the menu goes out
 *  of its way to avoid. Better to fail where it is wired than where it is
 *  clicked. */
export function useTour(): TourValue {
  const value = useContext(TourContext);
  if (!value) throw new Error('useTour must be used inside a TourProvider');
  return value;
}
