import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/motionLab', () => ({ listMotionPlays: vi.fn() }))
// jsdom cannot draw; the picture is playImage's business.
vi.mock('./playImage', () => ({ IMAGE_WIDTH: 1376, IMAGE_HEIGHT: 720, drawPlay: vi.fn() }))
import * as motionApi from '../api/motionLab'
import * as authModule from '../auth/AuthContext'
import MotionLabHomeCard, { HOME_PLAYS } from './MotionLabHomeCard'
import { newPlay } from './engine/play'
import { toDocument } from './storage/apiPlayRepository'

/**
 * MOTION LAB ON HOME: "Draw a play" goes straight to the field; an unsaved play
 * on this device comes back with "Continue"; the latest saved plays sit
 * underneath as pictures, one click from the editor.
 */

const row = (id: number, name: string, updated: string) => ({
  id,
  name,
  document: toDocument(newPlay(name)),
  schema_version: 3,
  revision: 1,
  folder_id: null,
  copied_from_play_id: null,
  created_by_coach_id: 1,
  created_at: updated,
  updated_at: updated,
})

function Where() {
  const location = useLocation()
  return <p data-testid="where">{location.pathname + (location.state ? ` ${JSON.stringify(location.state)}` : '')}</p>
}

function open() {
  vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, organization_id: 7, is_platform_owner: true } } as never)
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<MotionLabHomeCard />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  vi.mocked(motionApi.listMotionPlays).mockReset().mockResolvedValue([])
})

describe('Motion Lab on Home', () => {
  it('"Draw a play" opens Motion Lab on the field, and a first-timer is told what it is for', async () => {
    open()
    expect(await screen.findByText(/Draw a formation, give it routes/)).toBeInTheDocument()
    screen.getByRole('link', { name: 'Draw a play' }).click()
    expect(await screen.findByTestId('where')).toHaveTextContent('/motion-lab')
    expect(screen.getByTestId('where').textContent).toBe('/motion-lab')
  })

  it('shows the latest saved plays, newest first, each opening its play', async () => {
    vi.mocked(motionApi.listMotionPlays).mockResolvedValue([
      row(1, 'Old Dive', '2026-09-01T00:00:00Z'),
      row(2, 'Jet Dig', '2026-10-10T00:00:00Z'),
      row(3, 'Mesh', '2026-10-05T00:00:00Z'),
      row(4, 'Power', '2026-10-02T00:00:00Z'),
      row(5, 'Stick', '2026-10-01T00:00:00Z'),
    ] as never)
    open()
    const list = within(await screen.findByRole('list', { name: 'Recent plays' }))
    expect(list.getAllByRole('link').map((a) => a.textContent)).toEqual(['Jet Dig', 'Mesh', 'Power', 'Stick'])
    expect(list.getAllByRole('link')).toHaveLength(HOME_PLAYS)
    list.getByRole('link', { name: 'Mesh' }).click()
    expect(await screen.findByTestId('where')).toHaveTextContent('/motion-lab/plays/3')
    expect(screen.queryByText(/Draw a formation/)).toBeNull()
  })

  it('brings back an unsaved play with "Continue", and "+ New play" starts a fresh one', async () => {
    const play = { ...newPlay('New play'), updatedAt: Date.now() }
    localStorage.setItem('peira.motionlab.draft.v1:7:1:scratch', JSON.stringify({ play, touched: true, folderId: null }))
    open()
    expect(screen.getByText('not saved')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Draw a play' })).toBeNull()
    screen.getByRole('link', { name: '+ New play' }).click()
    expect(await screen.findByTestId('where')).toHaveTextContent('/motion-lab {"fresh":true}')
  })

  it('"Continue" goes back to the unsaved play', async () => {
    const play = { ...newPlay('New play'), updatedAt: Date.now() }
    localStorage.setItem('peira.motionlab.draft.v1:7:1:scratch', JSON.stringify({ play, touched: true, folderId: null }))
    open()
    screen.getByRole('link', { name: 'Continue “New play”' }).click()
    expect((await screen.findByTestId('where')).textContent).toBe('/motion-lab')
  })

  it('an untouched scratch play is not offered back - there is nothing to continue', async () => {
    localStorage.setItem('peira.motionlab.draft.v1:7:1:scratch', JSON.stringify({ play: newPlay('New play'), touched: false, folderId: null }))
    open()
    expect(screen.getByRole('link', { name: 'Draw a play' })).toBeInTheDocument()
    expect(screen.queryByText('not saved')).toBeNull()
    await waitFor(() => expect(motionApi.listMotionPlays).toHaveBeenCalled())
  })

  it('keeps working when the play list cannot be loaded', async () => {
    vi.mocked(motionApi.listMotionPlays).mockRejectedValue(new Error('offline'))
    open()
    expect(await screen.findByText(/Draw a formation/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Draw a play' })).toBeInTheDocument()
  })
})
