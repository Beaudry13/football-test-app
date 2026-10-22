import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import * as authModule from '../auth/AuthContext'
import { resetMotionLabSessions, toDocument } from './storage/apiPlayRepository'
import { fakeMotionServer, settle } from './storage/testing/fakeMotionApi'
import { dragPlayer, installPointerStubs } from './testing/pointerStubs'
import { gapPlays } from './__characterization__/fixtures'

const server = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof import('./storage/testing/fakeMotionApi').fakeMotionServer> }))
vi.mock('../api/motionLab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/motionLab')>()
  return {
    ...actual,
    listMotionPlays: () => Promise.resolve(server.current.playRows()),
    listMotionLooks: () => Promise.resolve(server.current.lookRows()),
    createMotionPlay: (...args: Parameters<typeof actual.createMotionPlay>) => server.current.api.createMotionPlay(...args),
    saveMotionPlay: (...args: Parameters<typeof actual.saveMotionPlay>) => server.current.api.saveMotionPlay(...args),
    getMotionPlay: (...args: Parameters<typeof actual.getMotionPlay>) => server.current.api.getMotionPlay(...args),
  }
})
vi.mock('../api/reps', () => ({ getMadeFromPlay: vi.fn() }))
vi.mock('../api/quizzes', () => ({ listQuizzes: vi.fn(async () => []), createQuiz: vi.fn() }))
vi.mock('../api/concepts', () => ({ listConcepts: vi.fn(async () => []), createConcept: vi.fn() }))
import * as repsApi from '../api/reps'
import MotionLabEditorPage from './MotionLabEditorPage'

/**
 * USE THIS PLAY, CONNECTED. The menu answers "what have I already made from
 * this play?" - only when there is something, each opening where it lives -
 * and the panels start from what the coach has already shown: the man he has
 * selected on the field.
 */

installPointerStubs()

const OWNER = { id: 1, organization_id: 7, is_platform_owner: true }

async function openAt(path: string) {
  vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: OWNER as never } as never)
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/motion-lab/plays/:playId" element={<MotionLabEditorPage />} />
        <Route path="/motion-lab" element={<MotionLabEditorPage />} />
        <Route path="/reps/:id" element={<div>rep page</div>} />
        <Route path="/quizzes/:id" element={<div>quiz editor</div>} />
      </Routes>
    </MemoryRouter>,
  )
  await waitFor(() => expect(document.querySelector('.motion-lab-root svg.board')).not.toBeNull())
  await act(async () => settle())
}

function seed() {
  const [a] = gapPlays()
  void server.current.api.createMotionPlay({ name: a.name, document: toDocument(a), schema_version: 1 })
  return a
}

beforeEach(() => {
  vi.clearAllMocks()
  server.current = fakeMotionServer()
  resetMotionLabSessions()
  localStorage.clear()
  vi.mocked(repsApi.getMadeFromPlay).mockResolvedValue({ made: [], last: null })
})
afterEach(async () => {
  window.dispatchEvent(new Event('online'))
  await act(async () => settle(10))
  vi.restoreAllMocks()
})

describe('Use this play: what was already made from it', () => {
  it('lists the quizzes and Reps made from this play, each opening where it lives', async () => {
    seed()
    await settle()
    vi.mocked(repsApi.getMadeFromPlay).mockResolvedValue({
      made: [
        { id: 8, title: 'Trips Jet - Boundary safety', kind: 'REP', from_play: 3, question_count: 4 },
        { id: 4, title: 'Week 6 install', kind: 'QUIZ', from_play: 1, question_count: 12 },
      ],
      last: null,
    })
    await openAt('/motion-lab/plays/100')
    fireEvent.click(screen.getByRole('button', { name: /Use this play/ }))
    const made = await screen.findByRole('group', { name: 'Made from this play' })
    expect(repsApi.getMadeFromPlay).toHaveBeenCalledWith(100)
    const rows = within(made).getAllByRole('menuitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      'Rep Trips Jet - Boundary safety3 decisions from this play',
      'Quiz Week 6 install1 question from this play',
    ])
    fireEvent.click(rows[0])
    expect(await screen.findByText('rep page')).toBeInTheDocument()
  })

  it('says nothing when nothing has been made', async () => {
    seed()
    await settle()
    await openAt('/motion-lab/plays/100')
    fireEvent.click(screen.getByRole('button', { name: /Use this play/ }))
    await waitFor(() => expect(repsApi.getMadeFromPlay).toHaveBeenCalledWith(100))
    expect(screen.queryByRole('group', { name: 'Made from this play' })).toBeNull()
    expect(within(screen.getByRole('menu', { name: 'Use this play' })).getAllByRole('menuitem')).toHaveLength(3)
  })

  it('the unsaved scratch play has nothing made from it to ask about', async () => {
    await openAt('/motion-lab')
    fireEvent.click(screen.getByRole('button', { name: /Use this play/ }))
    expect(screen.getByRole('menu', { name: 'Use this play' })).toBeInTheDocument()
    expect(repsApi.getMadeFromPlay).not.toHaveBeenCalled()
  })
})

describe('Use this play starts from the man on the field', () => {
  it('Make a quiz question: the man selected on the field is the man the Draw question is about', async () => {
    const a = seed()
    await settle()
    await openAt('/motion-lab/plays/100')
    dragPlayer(a, 'O8', 0, 0)
    fireEvent.click(screen.getByRole('button', { name: /Use this play/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Make a quiz question/ }))
    const label = a.players.find((p) => p.id === 'O8')!.label
    expect(screen.getByRole('combobox', { name: /Whose job/ })).toHaveValue('O8')
    expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue(`You're the ${label}. Draw your assignment.`)
  })

  it('with nobody selected, nobody is marked', async () => {
    seed()
    await settle()
    await openAt('/motion-lab/plays/100')
    fireEvent.click(screen.getByRole('button', { name: /Use this play/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Make a quiz question/ }))
    expect(screen.getByRole('combobox', { name: /Whose job/ })).toHaveValue('')
  })
})
