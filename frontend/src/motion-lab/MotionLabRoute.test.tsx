import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import * as authModule from '../auth/AuthContext'
import { ProtectedRoute } from '../auth/ProtectedRoute'
import { MotionLabEditorRoute, MotionLabGate, MotionLabLibraryRoute } from './MotionLabRoute'
import { sectionLinksFor } from '../components/notebook/sections'
import { SectionBar } from '../components/notebook/SectionBar'
import { resetMotionLabSessions, toDocument } from './storage/apiPlayRepository'
import { gapPlays } from './__characterization__/fixtures'

vi.mock('../api/motionLab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/motionLab')>()
  return {
    ...actual,
    listMotionPlays: vi.fn(),
    listMotionLooks: vi.fn(),
    listMotionFolders: vi.fn(),
  }
})
import * as motionApi from '../api/motionLab'

/**
 * WHO REACHES MOTION LAB DURING THE P2 PILOT: the platform owner, and nobody
 * else - neither its screens nor its navigation entry. Mounted exactly as
 * App.tsx mounts it, inside ProtectedRoute.
 */

const OWNER = { id: 1, organization_id: 7, is_platform_owner: true }
const COACH = { id: 2, organization_id: 7, is_platform_owner: false }

function renderAt(path: string, coach: object | null, isLoading = false) {
  vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: coach as never, isLoading } as never)
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route element={<MotionLabGate />}>
            <Route path="/motion-lab" element={<MotionLabLibraryRoute />} />
            <Route path="/motion-lab/folders/:folderId" element={<MotionLabLibraryRoute />} />
            <Route path="/motion-lab/plays/:playId" element={<MotionLabEditorRoute />} />
          </Route>
          <Route path="/dashboard" element={<div>coach dashboard</div>} />
        </Route>
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

const play = gapPlays()[0]
const row = {
  id: 41,
  name: play.name,
  document: toDocument(play),
  schema_version: 1,
  revision: 3,
  folder_id: null,
  copied_from_play_id: null,
  created_by_coach_id: 1,
  created_at: '2026-09-16T12:00:00Z',
  updated_at: '2026-09-16T12:00:00Z',
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  resetMotionLabSessions()
  localStorage.clear()
  vi.mocked(motionApi.listMotionPlays).mockResolvedValue([row as never])
  vi.mocked(motionApi.listMotionLooks).mockResolvedValue([])
  vi.mocked(motionApi.listMotionFolders).mockResolvedValue([])
})

describe('Motion Lab routes', () => {
  it('the owner reaches the Library', async () => {
    renderAt('/motion-lab', OWNER)
    expect(await screen.findByRole('heading', { name: 'Motion Lab' })).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: new RegExp(play.name) })).toHaveAttribute('href', '/motion-lab/plays/41')
  })

  it('the owner opens a play from the server in the full-screen editor', async () => {
    renderAt('/motion-lab/plays/41', OWNER)
    expect(await screen.findByRole('button', { name: 'Present' })).toBeInTheDocument()
    // The first render shows the editor's initial state; its load effect then opens the server play.
    await waitFor(() => expect(document.querySelector('.motion-lab-root .play-name')!.textContent).toBe(play.name))
    expect(screen.getByRole('status').textContent).toBe('Saved')
  })

  it.each(['/motion-lab', '/motion-lab/folders/3', '/motion-lab/plays/41'])(
    'any other coach is sent to their dashboard from %s, and nothing is fetched',
    (path) => {
      renderAt(path, COACH)
      expect(screen.getByText('coach dashboard')).toBeInTheDocument()
      expect(document.querySelector('.motion-lab-root')).toBeNull()
      expect(motionApi.listMotionPlays).not.toHaveBeenCalled()
    },
  )

  it.each(['/motion-lab', '/motion-lab/plays/41'])('a signed-out visitor is sent to login from %s', (path) => {
    renderAt(path, null)
    expect(screen.getByText('login page')).toBeInTheDocument()
  })

  it('a play that is not in the organization reads as not found', async () => {
    renderAt('/motion-lab/plays/999', OWNER)
    expect(await screen.findByText("This play isn't in your Motion Lab.")).toBeInTheDocument()
  })
})

describe('Motion Lab in the navigation', () => {
  it('is a section for the platform owner, after Quizzes', () => {
    expect(sectionLinksFor(OWNER).map((l) => l.label)).toEqual(['Quizzes', 'Motion Lab', 'Playbooks', 'Team'])
  })

  it('is not there for any other coach - they keep exactly three', () => {
    expect(sectionLinksFor(COACH).map((l) => l.label)).toEqual(['Quizzes', 'Playbooks', 'Team'])
  })

  it('the phone bar follows the same rule', () => {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: OWNER as never } as never)
    const { unmount } = render(
      <MemoryRouter initialEntries={['/motion-lab']}>
        <SectionBar />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: 'Motion Lab' })).toHaveAttribute('aria-current', 'page')
    unmount()
    vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: COACH as never } as never)
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <SectionBar />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('link', { name: 'Motion Lab' })).toBeNull()
  })
})
