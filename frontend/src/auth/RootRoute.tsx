import { useAuth } from './AuthContext';
import { DashboardPage } from '../pages/DashboardPage';
import { HomePage } from '../pages/HomePage';

/** "/" is the one route that isn't purely public or purely gated: a
 * signed-in coach should land on their dashboard, an anonymous visitor
 * should see the marketing homepage - same path, different content,
 * rather than bouncing an anonymous visitor to /login the way every other
 * protected route does. */
export function RootRoute() {
  const { coach, isLoading } = useAuth();

  if (isLoading) return null;
  return coach ? <DashboardPage /> : <HomePage />;
}
