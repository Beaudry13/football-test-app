import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

/** Catch-all for unmatched routes: a signed-in coach is sent back to their
 * dashboard, an anonymous visitor to the marketing homepage. */
export function NotFoundRedirect() {
  const { coach, isLoading } = useAuth();

  if (isLoading) return null;
  return <Navigate to={coach ? '/dashboard' : '/'} replace />;
}
