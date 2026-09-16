import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import * as authModule from '../auth/AuthContext'
import { ProtectedRoute } from '../auth/ProtectedRoute'
import { MotionLabRoute } from './MotionLabRoute'
import { SECTION_LINKS } from '../components/notebook/sections'

/**
 * WHO REACHES MOTION LAB IN P1: the platform owner, and nobody else.
 *
 * Mounted exactly as App.tsx mounts it - inside ProtectedRoute - so a signed-
 * out visitor is sent to login before the owner check is even asked.
 */

function renderAt(coach: { is_platform_owner: boolean } | null, isLoading = false) {
  vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: coach as never, isLoading } as never)
  return render(
    <MemoryRouter initialEntries={['/motion-lab']}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/motion-lab" element={<MotionLabRoute />} />
          <Route path="/dashboard" element={<div>coach dashboard</div>} />
        </Route>
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('Motion Lab route', () => {
  it('opens the editor, full screen under its style root, for the platform owner', async () => {
    renderAt({ is_platform_owner: true })
    // Lazy chunk: wait for it.
    expect(await screen.findByRole('button', { name: 'Present' })).toBeInTheDocument()
    const root = document.querySelector('.motion-lab-root')!
    expect(root).toBeInTheDocument()
    expect(root.querySelector('.app svg.board')).toBeInTheDocument()
    expect(document.title).toBe('Motion Lab — Peira')
  })

  it('sends any other coach to their dashboard without rendering the editor', () => {
    renderAt({ is_platform_owner: false })
    expect(screen.getByText('coach dashboard')).toBeInTheDocument()
    expect(document.querySelector('.motion-lab-root')).toBeNull()
  })

  it('sends a signed-out visitor (a player, anyone) to login', () => {
    renderAt(null)
    expect(screen.getByText('login page')).toBeInTheDocument()
    expect(document.querySelector('.motion-lab-root')).toBeNull()
  })

  it('renders nothing while the session is still resolving', () => {
    renderAt(null, true)
    expect(document.body.textContent).toBe('')
  })

  it('offers a way back into PEIRA', async () => {
    renderAt({ is_platform_owner: true })
    fireEvent.click(await screen.findByRole('button', { name: '← Peira' }))
    expect(screen.getByText('coach dashboard')).toBeInTheDocument()
    expect(document.querySelector('.motion-lab-root')).toBeNull()
  })

  it('is not in the coach navigation', () => {
    expect(SECTION_LINKS.map((l) => l.to)).not.toContain('/motion-lab')
  })
})
