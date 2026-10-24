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
vi.mock('../api/installs', () => ({ installsFor: vi.fn(), addToInstall: vi.fn(), createInstall: vi.fn() }))
import * as repsApi from '../api/reps'
import * as installsApi from '../api/installs'
import MotionLabEditorPage from './MotionLabEditorPage'

/**
 * USE THIS PLAY, CONNECTED. The menu answers "what have I already made from
 * this play?" - only when there is something, each opening where it lives -
 * and the panels start from what the coach has already shown: the man he has
 * selected on the field.
 */

installPointerStubs()

const OWNER = { id: 1, organization_id: 7, is_platform_owner: true }

async function openAt(path: string, state: unknown = null) {
  vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: OWNER as never } as never)
  const [pathname, search = ''] = path.split('?')
  render(
    <MemoryRouter initialEntries={[{ pathname, search: search ? `?${search}` : '', state }]}>
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
        { id: 8, title: 'Trips Jet - Boundary safety', kind: 'REP', from_play: 3, question_count: 4, concepts: ['Motion adjustment'], roles: ['Boundary safety'], taught_at: '2026-10-21T15:00:00Z' },
        { id: 4, title: 'Week 6 install', kind: 'QUIZ', from_play: 1, question_count: 12, concepts: [], roles: [], taught_at: null },
      ],
      last: null,
    })
    await openAt('/motion-lab/plays/100')
    fireEvent.click(screen.getByRole('button', { name: /Use this play/ }))
    const made = await screen.findByRole('group', { name: 'Made from this play' })
    expect(repsApi.getMadeFromPlay).toHaveBeenCalledWith(100)
    const rows = within(made).getAllByRole('menuitem')
    // What, who, and whether it was taught - in the coach's own words.
    expect(rows.map((r) => r.textContent)).toEqual([
      'Rep Trips Jet - Boundary safety3 decisions · Boundary safety · Motion adjustment · taught Oct 21',
      'Quiz Week 6 install1 question',
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
    const items = within(screen.getByRole('menu', { name: 'Use this play' })).getAllByRole('menuitem')
    expect(items.map((i) => i.textContent?.split(' ').slice(0, 3).join(' '))).toEqual(['Make a rep', 'Make a quiz', 'Teach a moment', 'Add to install'])
  })

  it('the unsaved scratch play has nothing made from it to ask about', async () => {
    await openAt('/motion-lab')
    fireEvent.click(screen.getByRole('button', { name: /Use this play/ }))
    expect(screen.getByRole('menu', { name: 'Use this play' })).toBeInTheDocument()
    expect(repsApi.getMadeFromPlay).not.toHaveBeenCalled()
    // An install refers to a play in PEIRA - the scratch play is not one yet.
    expect(screen.queryByRole('menuitem', { name: /Add to install/ })).toBeNull()
  })
})

describe("Use this play: into this week's install", () => {
  it('adds the saved play to an install by reference, and says it is in', async () => {
    seed()
    await settle()
    vi.mocked(installsApi.installsFor).mockResolvedValue([
      { id: 5, title: 'Week 7 - West Virginia', has: false },
      { id: 6, title: 'Safeties - Week 7', has: true },
    ])
    vi.mocked(installsApi.addToInstall).mockResolvedValue({} as never)
    await openAt('/motion-lab/plays/100')
    fireEvent.click(screen.getByRole('button', { name: /Use this play/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Add to install/ }))
    const panel = within(screen.getByRole('dialog', { name: 'Add to install' }))
    expect(installsApi.installsFor).toHaveBeenCalledWith('play', 100)
    expect(await panel.findByText('Week 7 - West Virginia')).toBeInTheDocument()
    expect(panel.getByRole('link', { name: '✓ In it' })).toHaveAttribute('href', '/installs/6')
    fireEvent.click(panel.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(installsApi.addToInstall).toHaveBeenCalledWith(5, 'play', 100))
    expect(await panel.findAllByRole('link', { name: '✓ In it' })).toHaveLength(2)
  })
})

describe("An install meeting's Check them opens the panel that makes it", () => {
  it('?make=question&man= opens Make a quiz question about that man', async () => {
    const a = seed()
    await settle()
    await openAt('/motion-lab/plays/100?make=question&man=O8')
    const label = a.players.find((p) => p.id === 'O8')!.label
    expect(screen.getByRole('dialog', { name: 'Make a quiz question' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /Whose job/ })).toHaveValue('O8')
    expect(screen.getByRole('textbox', { name: 'Question' })).toHaveValue(`You're the ${label}. Draw your assignment.`)
  })

  it('?make=rep opens Make a rep; anything else opens nothing', async () => {
    seed()
    await settle()
    await openAt('/motion-lab/plays/100?make=rep&man=O8')
    expect(screen.getByRole('dialog', { name: 'Make a rep' })).toBeInTheDocument()
  })

  it('an unknown ?make= opens no panel', async () => {
    seed()
    await settle()
    await openAt('/motion-lab/plays/100?make=everything')
    expect(screen.queryByRole('dialog', { name: 'Make a rep' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'Make a quiz question' })).toBeNull()
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

describe('Use this play: have I already taught it?', () => {
  it('teaching a moment from the play is remembered, and the menu says when', async () => {
    seed()
    await settle()
    await openAt('/motion-lab/plays/100')
    fireEvent.click(screen.getByRole('button', { name: /Use this play/ }))
    expect(screen.queryByText(/You taught it/)).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Teach a moment/ }))
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Teach this play' })).getByRole('button', { name: 'Teach' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: /Use this play/ }))
    const made = await screen.findByRole('group', { name: 'Made from this play' })
    expect(made).toHaveTextContent(/You taught it/)
  })
})

describe('Motion Lab -> Teach, from what PEIRA already knows', () => {
  it('the man selected on the field is the man to watch, and his point and concept come from what was made', async () => {
    const a = seed()
    await settle()
    vi.mocked(repsApi.getMadeFromPlay).mockResolvedValue({
      made: [{ id: 8, title: 'Trips Jet - Boundary safety', kind: 'REP', from_play: 2, question_count: 2, concepts: ['Motion adjustment'], roles: [], taught_at: null }],
      last: { concept: { id: 3, name: 'Motion adjustment' }, subject_man: null, subject_role: null, answer_explanation: 'He is the new #3 - rotate down.' },
    })
    await openAt('/motion-lab/plays/100')
    dragPlayer(a, 'O8', 0, 0)
    fireEvent.click(screen.getByRole('button', { name: /Use this play/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Teach a moment/ }))
    const panel = within(screen.getByRole('dialog', { name: 'Teach this play' }))
    expect(panel.getByRole('textbox', { name: /You.re the/ })).not.toHaveValue('')
    expect(await panel.findByDisplayValue('He is the new #3 - rotate down.')).toBeInTheDocument()
    fireEvent.click(panel.getByRole('button', { name: 'Teach' }))
    const teach = within(screen.getByRole('dialog', { name: `Teach ${a.name}` }))
    expect(teach.getByText('Motion adjustment')).toBeInTheDocument()
    expect(teach.getByText(/You.re the/)).toBeInTheDocument()
    expect(teach.getByText('He is the new #3 - rotate down.')).toBeInTheDocument()
  })

  it('Check them: what is made from the play first, then make the check for the same man', async () => {
    const a = seed()
    await settle()
    vi.mocked(repsApi.getMadeFromPlay).mockResolvedValue({
      made: [{ id: 8, title: 'Trips Jet - Boundary safety', kind: 'REP', from_play: 2, question_count: 2, concepts: [], roles: [], taught_at: null }],
      last: null,
    })
    await openAt('/motion-lab/plays/100')
    dragPlayer(a, 'O8', 0, 0)
    fireEvent.click(screen.getByRole('button', { name: /Use this play/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Teach a moment/ }))
    await waitFor(() => expect(repsApi.getMadeFromPlay).toHaveBeenCalledTimes(2))
    await act(async () => settle())
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Teach this play' })).getByRole('button', { name: 'Teach' }))
    const teach = within(screen.getByRole('dialog', { name: `Teach ${a.name}` }))
    fireEvent.click(teach.getByRole('button', { name: /Check them/ }))
    const check = within(teach.getByRole('menu', { name: 'Check them' }))
    expect(check.getByRole('menuitem', { name: /Trips Jet - Boundary safety/ })).toHaveAttribute('href', '/reps/8')
    fireEvent.click(check.getByRole('menuitem', { name: /Make a quiz question/ }))
    // Teach gives way to the panel that makes it - the man already chosen.
    expect(screen.queryByRole('dialog', { name: `Teach ${a.name}` })).toBeNull()
    expect(screen.getByRole('combobox', { name: /Whose job/ })).toHaveValue('O8')
  })
})

describe('Back to where the coach came from', () => {
  it('opened from a quiz, the top bar offers the way back to it beside Home and Library', async () => {
    seed()
    await settle()
    await openAt('/motion-lab/plays/100', { from: { to: '/quizzes/4?tab=results', label: 'Week 6 install' } })
    const back = screen.getByRole('button', { name: /Week 6 install/ })
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument()
    fireEvent.click(back)
    expect(await screen.findByText('quiz editor')).toBeInTheDocument()
  })

  it('opened on its own, only Home and Library', async () => {
    seed()
    await settle()
    await openAt('/motion-lab/plays/100')
    expect(screen.queryByRole('button', { name: /^←/ })).toBeNull()
  })
})
