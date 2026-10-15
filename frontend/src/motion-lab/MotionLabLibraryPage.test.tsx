import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { acceptConfirm } from '../test/confirmDialog'
import type { Folder } from '../api/types'
import type { MotionLookRow, MotionPlayRow } from '../api/motionLab'

vi.mock('../api/motionLab', () => ({
  listMotionFolders: vi.fn(),
  listMotionPlays: vi.fn(),
  listMotionLooks: vi.fn(),
  createMotionPlay: vi.fn(),
  createMotionFolder: vi.fn(),
  updateMotionPlay: vi.fn(),
  copyMotionPlay: vi.fn(),
  deleteMotionPlay: vi.fn(),
  deleteMotionLook: vi.fn(),
}))
vi.mock('../api/folders', () => ({ renameFolder: vi.fn(), deleteFolder: vi.fn() }))
import * as motionApi from '../api/motionLab'
import * as foldersApi from '../api/folders'
import * as authModule from '../auth/AuthContext'
import { MotionLabLibraryPage } from './MotionLabLibraryPage'
import { newPlay } from './engine/play'

/**
 * The Motion Lab Library: the organization's plays filed in nested Motion Lab
 * folders, and its looks. Everything a coach does here is one API call; what
 * is pinned is that each control makes the right one.
 */

const folder = (id: number, name: string, parent: number | null = null): Folder => ({
  id,
  organization_id: 7,
  coach_id: 1,
  name,
  parent_folder_id: parent,
  area: 'motion',
  created_at: '2026-09-16T12:00:00Z',
  updated_at: '2026-09-16T12:00:00Z',
})
const play = (id: number, name: string, folderId: number | null = null): MotionPlayRow => ({
  id,
  name,
  document: { players: [], ball: null, ballThen: null, engagements: [], situation: {}, filter: 'all' },
  schema_version: 1,
  revision: 1,
  folder_id: folderId,
  copied_from_play_id: null,
  created_by_coach_id: 1,
  created_at: '2026-09-16T12:00:00Z',
  updated_at: '2026-09-16T12:00:00Z',
})
const look = (id: number, name: string): MotionLookRow => ({
  id,
  name,
  document: { players: [{ id: 'O0', side: 'offense', label: 'QB', x: 26.6, y: -2.4, path: [], timing: 'on-snap', delay: 0.5, speed: 'normal' }] },
  schema_version: 1,
  revision: 1,
  created_by_coach_id: 1,
  created_at: '2026-09-16T12:00:00Z',
  updated_at: '2026-09-16T12:00:00Z',
})

const FOLDERS = [folder(1, 'Defense'), folder(2, 'Coverages', 1), folder(3, 'Cover 3', 2), folder(4, 'Offense')]
const PLAYS = [play(10, 'Inside Zone'), play(11, 'Cover 3 vs Mesh', 3), play(12, 'Tampa 2', 2)]
const LOOKS = [look(20, 'Trips Rt')]

let lastPath = ''
let lastState: unknown = null
function PathProbe() {
  const location = useLocation()
  lastPath = location.pathname
  lastState = location.state
  return null
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <PathProbe />
      <Routes>
        <Route path="/motion-lab/library" element={<MotionLabLibraryPage />} />
        <Route path="/motion-lab/folders/:folderId" element={<MotionLabLibraryPage />} />
        <Route path="/motion-lab" element={<div>field</div>} />
        <Route path="/motion-lab/plays/:playId" element={<div>editor</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(motionApi.listMotionFolders).mockResolvedValue(FOLDERS)
  vi.mocked(motionApi.listMotionPlays).mockResolvedValue(PLAYS)
  vi.mocked(motionApi.listMotionLooks).mockResolvedValue(LOOKS)
  vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, organization_id: 7 } } as never)
  window.localStorage.clear()
  lastPath = ''
  lastState = null
})

describe('Motion Lab Library', () => {
  it('shows the top level: root folders with play counts, unfiled plays, and looks', async () => {
    renderAt('/motion-lab/library')
    expect(await screen.findByRole('heading', { name: 'Motion Lab' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Defense\s*2/ })).toHaveAttribute('href', '/motion-lab/folders/1')
    expect(screen.getByRole('link', { name: /Offense\s*0/ })).toBeInTheDocument()
    const plays = within(screen.getByLabelText('Plays'))
    expect(plays.getAllByRole('link').map((l) => l.textContent)).toEqual([expect.stringContaining('Inside Zone')])
    expect(within(screen.getByLabelText('Saved looks')).getByText('Trips Rt')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Coverages/ })).toBeNull()
  })

  it('goes into nested folders with the whole path in the breadcrumb', async () => {
    renderAt('/motion-lab/folders/2')
    expect(await screen.findByRole('heading', { name: 'Coverages' })).toBeInTheDocument()
    const path = within(screen.getByRole('navigation', { name: 'Motion Lab folder path' }))
    expect(path.getByRole('link', { name: 'Motion Lab' })).toHaveAttribute('href', '/motion-lab/library')
    expect(path.getByRole('link', { name: 'Defense' })).toHaveAttribute('href', '/motion-lab/folders/1')
    expect(screen.getByRole('link', { name: /Cover 3\s*1/ })).toHaveAttribute('href', '/motion-lab/folders/3')
    expect(within(screen.getByLabelText('Plays')).getByRole('link', { name: /Tampa 2/ })).toHaveAttribute('href', '/motion-lab/plays/12')
    expect(screen.queryByLabelText('Saved looks')).toBeNull()
  })

  it('New play opens the field, in this folder - nothing is created until the coach saves it', async () => {
    renderAt('/motion-lab/folders/2')
    await userEvent.click(await screen.findByRole('button', { name: /New play/ }))
    await waitFor(() => expect(lastPath).toBe('/motion-lab'))
    expect(lastState).toEqual({ fresh: true, folderId: 2 })
    expect(motionApi.createMotionPlay).not.toHaveBeenCalled()
  })

  it('a look opens the field with its alignment - nothing is created until the coach saves it', async () => {
    renderAt('/motion-lab/library')
    await userEvent.click(within(await screen.findByLabelText('Saved looks')).getByRole('button', { name: 'New play from Trips Rt' }))
    await waitFor(() => expect(lastPath).toBe('/motion-lab'))
    const state = lastState as { fresh: boolean; folderId: number | null; name: string; players: { label: string }[] }
    expect(state).toMatchObject({ fresh: true, folderId: null, name: 'Trips Rt — new play' })
    expect(state.players.map((p) => p.label)).toEqual(['QB'])
    expect(motionApi.createMotionPlay).not.toHaveBeenCalled()
  })

  it('offers to continue the unsaved play on this device, once it has work in it', async () => {
    const key = 'peira.motionlab.draft.v1:7:1:scratch'
    window.localStorage.setItem(key, JSON.stringify({ play: { ...newPlay('Jet sweep idea'), id: 'scratch_1' }, touched: false }))
    renderAt('/motion-lab/library')
    await screen.findByRole('heading', { name: 'Motion Lab' })
    expect(screen.queryByLabelText('Unsaved play')).toBeNull()
    window.localStorage.setItem(key, JSON.stringify({ play: { ...newPlay('Jet sweep idea'), id: 'scratch_1' }, touched: true }))
    renderAt('/motion-lab/library')
    const row = within(await screen.findByLabelText('Unsaved play'))
    expect(row.getByText('Jet sweep idea')).toBeInTheDocument()
    await userEvent.click(row.getByRole('button', { name: 'Continue' }))
    expect(lastPath).toBe('/motion-lab')
  })

  it('creates a subfolder inside the current folder', async () => {
    vi.mocked(motionApi.createMotionFolder).mockResolvedValue(folder(5, 'Cover 1', 2))
    renderAt('/motion-lab/folders/2')
    await userEvent.type(await screen.findByLabelText('New folder name'), 'Cover 1')
    await userEvent.click(screen.getByRole('button', { name: 'New folder' }))
    expect(motionApi.createMotionFolder).toHaveBeenCalledWith({ name: 'Cover 1', parent_folder_id: 2 })
  })

  it('renames, duplicates, moves and deletes a play', async () => {
    const user = userEvent.setup()
    vi.mocked(motionApi.updateMotionPlay).mockResolvedValue(play(10, 'x'))
    vi.mocked(motionApi.copyMotionPlay).mockResolvedValue(play(13, 'Inside Zone (copy)'))
    vi.mocked(motionApi.deleteMotionPlay).mockResolvedValue(undefined)
    vi.mocked(motionApi.listMotionFolders).mockResolvedValue([...FOLDERS].reverse())
    renderAt('/motion-lab/library')

    await user.click(await screen.findByRole('button', { name: 'Play options for Inside Zone' }))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText('New name')
    await user.clear(input)
    await user.type(input, 'Inside Zone Rt{Enter}')
    expect(motionApi.updateMotionPlay).toHaveBeenCalledWith(10, { name: 'Inside Zone Rt' })

    await user.click(await screen.findByRole('button', { name: 'Play options for Inside Zone' }))
    await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }))
    expect(motionApi.copyMotionPlay).toHaveBeenCalledWith(10)

    await user.click(await screen.findByRole('button', { name: 'Play options for Inside Zone' }))
    await user.click(screen.getByRole('menuitem', { name: 'Move to folder…' }))
    // Listed by path, so a folder sits under its parent however the server ordered them.
    expect(within(screen.getByLabelText('Move Inside Zone to folder')).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Top of the Library',
      'Defense',
      'Defense / Coverages',
      'Defense / Coverages / Cover 3',
      'Offense',
    ])
    await user.selectOptions(screen.getByLabelText('Move Inside Zone to folder'), 'Defense / Coverages / Cover 3')
    expect(motionApi.updateMotionPlay).toHaveBeenCalledWith(10, { folder_id: 3 })

    await user.click(await screen.findByRole('button', { name: 'Play options for Inside Zone' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete play' }))
    await acceptConfirm(user, 'Delete Play')
    expect(motionApi.deleteMotionPlay).toHaveBeenCalledWith(10)
  })

  it('renames and deletes a folder, and will not offer deleting one that has folders in it', async () => {
    const user = userEvent.setup()
    vi.mocked(foldersApi.renameFolder).mockResolvedValue(folder(4, 'Offense Library'))
    vi.mocked(foldersApi.deleteFolder).mockResolvedValue(undefined)
    renderAt('/motion-lab/library')

    await user.click(await screen.findByRole('button', { name: 'Folder options for Defense' }))
    expect(screen.getByRole('menuitem', { name: /empty its folders first/ })).toBeDisabled()
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: 'Folder options for Offense' }))
    await user.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const input = screen.getByLabelText('New name')
    await user.clear(input)
    await user.type(input, 'Offense Library{Enter}')
    expect(foldersApi.renameFolder).toHaveBeenCalledWith(4, { name: 'Offense Library' })

    await user.click(await screen.findByRole('button', { name: 'Folder options for Offense' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete folder' }))
    // The server puts the plays at the top level (folder_id SET NULL), and the dialog says so.
    expect(screen.getByText(/they move to the top of the Library/)).toBeInTheDocument()
    await acceptConfirm(user, 'Delete Folder')
    expect(foldersApi.deleteFolder).toHaveBeenCalledWith(4)
  })

  it('deletes a look', async () => {
    const user = userEvent.setup()
    vi.mocked(motionApi.deleteMotionLook).mockResolvedValue(undefined)
    renderAt('/motion-lab/library')
    await user.click(await screen.findByRole('button', { name: 'Look options for Trips Rt' }))
    await user.click(screen.getByRole('menuitem', { name: 'Delete look' }))
    await acceptConfirm(user, 'Delete Look')
    expect(motionApi.deleteMotionLook).toHaveBeenCalledWith(20)
  })

  it('says so when a folder is not in this Motion Lab', async () => {
    renderAt('/motion-lab/folders/404')
    expect(await screen.findByText(/This folder isn't in your Motion Lab/)).toBeInTheDocument()
  })

  it('does not claim the Library is empty when every play is filed in a folder', async () => {
    vi.mocked(motionApi.listMotionPlays).mockResolvedValue([play(11, 'Cover 3 vs Mesh', 3)])
    renderAt('/motion-lab/library')
    expect(await screen.findByRole('link', { name: /Defense\s*1/ })).toBeInTheDocument()
    expect(screen.queryByText('No plays yet. Start one with New play.')).toBeNull()
    expect(screen.queryByLabelText('Plays')).toBeNull()
  })

  it('an empty Library says how to start', async () => {
    vi.mocked(motionApi.listMotionFolders).mockResolvedValue([])
    vi.mocked(motionApi.listMotionPlays).mockResolvedValue([])
    vi.mocked(motionApi.listMotionLooks).mockResolvedValue([])
    renderAt('/motion-lab/library')
    expect(await screen.findByText('No plays yet. Start one with New play.')).toBeInTheDocument()
  })
})
