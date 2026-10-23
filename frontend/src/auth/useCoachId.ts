import { useAuth } from './AuthContext';

/**
 * The signed-in coach's id, for per-coach memory kept on a device ("pick up
 * where you left off", "same as last time") - so two coaches sharing a laptop
 * never see each other's. Null when there is no coach to ask: a component
 * rendered on its own, as in its tests, simply remembers nothing.
 */
export function useCoachId(): number | null {
  try {
    const { coach } = useAuth();
    return coach ? coach.id : null;
  } catch {
    return null;
  }
}
