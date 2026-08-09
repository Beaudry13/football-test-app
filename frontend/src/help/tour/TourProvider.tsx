import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { DashboardTour } from './DashboardTour';
import { TourContext } from './tourContext';

/** Owns whether the tour is running, and mounts it once for the whole app.
 *
 *  It lives at the app root rather than on the dashboard because the two
 *  things that launch it are in different places - the Help menu (in the
 *  header, on every page) and the setup checklist (on the dashboard) - and
 *  neither should have to know how a tour works.
 *
 *  Nothing here is persisted. The tour is replayable help, not a step of
 *  onboarding, so there is no "seen it" flag to keep.
 */
export function TourProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const navigate = useNavigate();

  const start = useCallback(() => {
    // Every target is dashboard or header chrome, so the tour has to be
    // standing on the dashboard. Launching from Help on /roster navigates
    // first; the engine waits for the targets to mount (see
    // RESOLVE_TIMEOUT_MS) rather than skipping every step on an empty page.
    navigate('/dashboard');
    setActive(true);
  }, [navigate]);

  const stop = useCallback(() => setActive(false), []);

  const value = useMemo(() => ({ start, active }), [start, active]);

  return (
    <TourContext.Provider value={value}>
      {children}
      {active && <DashboardTour onFinish={stop} />}
    </TourContext.Provider>
  );
}
