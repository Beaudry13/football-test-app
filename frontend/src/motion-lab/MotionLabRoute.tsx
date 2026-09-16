import { lazy, Suspense } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'

const MotionLabPage = lazy(() => import('./MotionLabPage'))

/**
 * MOTION LAB IS PLATFORM-OWNER ONLY IN P1.
 *
 * Unlike the Owner Dashboard, there is no server behind this screen yet:
 * plays live in the browser. So this check is not cosmetic defence in depth -
 * it is the whole of what keeps unfinished, browser-only persistence away from
 * coaches. It sits inside ProtectedRoute, which has already resolved the coach
 * (and sent anyone signed out to /login); players never reach it at all.
 *
 * Anyone else is sent to their dashboard, the same answer OwnerLayout gives,
 * and never downloads the editor: the page is a separate lazy chunk.
 */
export function MotionLabRoute() {
  const { coach } = useAuth()
  if (!coach?.is_platform_owner) {
    return <Navigate to="/dashboard" replace />
  }
  return (
    <Suspense fallback={null}>
      <MotionLabPage />
    </Suspense>
  )
}
