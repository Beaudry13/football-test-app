import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext';

export function ProtectedRoute() {
  const { coach, isLoading } = useAuth();

  if (isLoading) return null;
  if (!coach) return <Navigate to="/login" replace />;

  return <Outlet />;
}
