import { lazy, Suspense } from 'react'
import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { mayUseMotionLab } from './motionLabAccess'

/**
 * MOTION LAB IS PLATFORM-OWNER ONLY DURING THE P2 PILOT.
 *
 * The frontend half of `require_motion_lab_coach` (backend/app/utils/auth.py),
 * which is the real boundary: every Motion Lab API route and every motion
 * folder route refuses anyone else with a 404. This gate keeps the screens and
 * their code away from coaches outside the pilot - they are sent to their
 * dashboard, the same answer OwnerLayout gives, and never download the chunk.
 *
 * Mounted inside ProtectedRoute, which has already resolved the coach and sent
 * anyone signed out (a player, anyone) to /login.
 *
 * Opening Motion Lab to coaches later changes mayUseMotionLab and the backend
 * check - nothing else.
 */
export function MotionLabGate() {
  const { coach } = useAuth()
  if (!mayUseMotionLab(coach)) {
    return <Navigate to="/dashboard" replace />
  }
  return <Outlet />
}

const LibraryPage = lazy(() => import('./MotionLabLibraryPage').then((m) => ({ default: m.MotionLabLibraryPage })))
const EditorPage = lazy(() => import('./MotionLabEditorPage'))

/** The Library, inside NotebookLayout like Playbooks. */
export function MotionLabLibraryRoute() {
  return (
    <Suspense fallback={null}>
      <LibraryPage />
    </Suspense>
  )
}

/** One play in the full-screen editor, outside NotebookLayout like annotation. */
export function MotionLabEditorRoute() {
  return (
    <Suspense fallback={null}>
      <EditorPage />
    </Suspense>
  )
}
