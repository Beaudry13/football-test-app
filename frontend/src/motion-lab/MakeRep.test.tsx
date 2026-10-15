import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/quizzes', () => ({ listQuizzes: vi.fn(), createQuiz: vi.fn() }))
vi.mock('../api/questions', () => ({ createQuestion: vi.fn() }))
vi.mock('../api/concepts', () => ({ listConcepts: vi.fn(), createConcept: vi.fn() }))
// jsdom cannot draw; the picture is playImage's business.
vi.mock('./playImage', () => ({
  IMAGE_WIDTH: 1376,
  IMAGE_HEIGHT: 720,
  drawPlay: vi.fn(),
  playImage: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}))
import * as quizzesApi from '../api/quizzes'
import * as questionsApi from '../api/questions'
import * as conceptsApi from '../api/concepts'
import * as image from './playImage'
import { MakeRep } from './MakeRep'
import { newPlay, type Play } from './engine/play'
import { px } from './playImageLayout'

/**
 * MOTION LAB -> SITUATIONAL REP. Tap the man he is, say the situation, give the
 * answers (or one tap: Coverage, Leverage...), name the concept - and the
 * decision lands in a Rep, picture and all, with the play it came from.
 */

let path = ''
function Probe() {
  path = useLocation().pathname
  return null
}

function open(play: Play = newPlay('Trips Jet'), motionPlayId: number | null = 14) {
  render(
    <MemoryRouter initialEntries={['/motion-lab']}>
      <Probe />
      <Routes>
        <Route path="/motion-lab" element={<MakeRep play={play} motionPlayId={motionPlayId} onClose={vi.fn()} />} />
        <Route path="/reps/:id" element={<p>rep page</p>} />
      </Routes>
    </MemoryRouter>,
  )
  return play
}

beforeEach(() => {
  vi.clearAllMocks()
  path = ''
  vi.mocked(quizzesApi.listQuizzes).mockResolvedValue([
    { id: 3, title: 'Week 3 install', kind: 'QUIZ', question_count: 4, updated_at: '2026-10-01' },
    { id: 8, title: 'Red zone - Mike', kind: 'REP', question_count: 2, updated_at: '2026-10-09' },
  ] as never)
  vi.mocked(quizzesApi.createQuiz).mockResolvedValue({ id: 40, title: 'Trips Jet - Boundary safety', question_count: 0 } as never)
  vi.mocked(questionsApi.createQuestion).mockResolvedValue({ id: 900 } as never)
  vi.mocked(conceptsApi.listConcepts).mockResolvedValue([{ id: 2, name: 'Leverage', is_archived: false }])
  vi.mocked(conceptsApi.createConcept).mockResolvedValue({ id: 5, name: 'Motion adjustment', is_archived: false })
})

const type = (label: RegExp | string, value: string, role: 'textbox' | 'combobox' = 'textbox') =>
  fireEvent.change(screen.getByRole(role, { name: label }), { target: { value } })

describe('Make a rep from a play', () => {
  it('tapping a man names who he is, in football words', () => {
    const play = open()
    const picture = screen.getByLabelText('The picture the player will see')
    picture.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1376, height: 720, right: 1376, bottom: 720, x: 0, y: 0, toJSON: () => ({}) })
    const fs = play.players.find((p) => p.label === 'FS')!
    fireEvent.click(picture, { clientX: px(fs).x, clientY: px(fs).y })
    expect(screen.getByRole('textbox', { name: /You’re the/ })).toHaveValue('Free safety')
    expect(vi.mocked(image.drawPlay).mock.lastCall![2]).toMatchObject({ highlight: fs.id })
  })

  it('makes the decision in a new Rep named after the play: role, situation, answers, concept, reason, picture and play', async () => {
    open()
    type(/You’re the/, 'Boundary safety')
    type('The situation', '#3 motions across. What is your check?')
    type('Answer 1', 'Rotate down')
    type('Answer 2', 'Stay boundary')
    type('Answer 3', 'Bail deep')
    // The right one is the second circle tapped, not the default.
    fireEvent.click(screen.getByRole('radio', { name: 'Answer 1 is the right one' }))
    type(/Concept/, 'Motion adjustment', 'combobox')
    type(/Why/, 'He is the new #3.')
    const make = screen.getByRole('button', { name: 'Make rep' })
    await waitFor(() => expect(make).toBeEnabled())
    fireEvent.click(make)

    expect(await screen.findByText(/Decision 1 added to/)).toBeInTheDocument()
    expect(quizzesApi.createQuiz).toHaveBeenCalledWith({ title: 'Trips Jet - Boundary safety', kind: 'REP' })
    expect(conceptsApi.createConcept).toHaveBeenCalledWith('Motion adjustment')
    const [repId, input, file] = vi.mocked(questionsApi.createQuestion).mock.calls[0]
    expect(repId).toBe(40)
    expect(input).toEqual({
      question_text: '#3 motions across. What is your check?',
      question_type: 'multiple_choice',
      options: [
        { option_text: 'Rotate down', is_correct_answer: true },
        { option_text: 'Stay boundary', is_correct_answer: false },
        { option_text: 'Bail deep', is_correct_answer: false },
      ],
      concept_id: 5,
      subject_role: 'Boundary safety',
      motion_play_id: 14,
      answer_explanation: 'He is the new #3.',
    })
    expect((file as File).type).toBe('image/png')

    // The next decision goes to the same Rep; Open rep goes to its page.
    fireEvent.click(screen.getByRole('button', { name: 'Add another decision' }))
    expect(screen.getByRole('combobox', { name: /Put it in/ })).toHaveValue('40')
    expect(screen.getByRole('textbox', { name: /You’re the/ })).toHaveValue('Boundary safety')
    expect(screen.getByRole('textbox', { name: 'The situation' })).toHaveValue('')
  })

  it('one tap fills a common set of answers, and an existing concept and Rep are reused', async () => {
    open()
    fireEvent.click(within(screen.getByRole('group', { name: 'Quick answers' })).getByRole('button', { name: 'Coverage' }))
    expect(screen.getByRole('textbox', { name: 'Answer 4' })).toHaveValue('Quarters')
    fireEvent.click(screen.getByRole('radio', { name: 'Answer 3 is the right one' }))
    type('The situation', 'Identify the coverage.')
    type(/Concept/, 'leverage', 'combobox')
    await waitFor(() => expect(within(screen.getByRole('combobox', { name: /Put it in/ })).getAllByRole('option')).toHaveLength(2))
    fireEvent.change(screen.getByRole('combobox', { name: /Put it in/ }), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make rep' }))
    await waitFor(() => expect(questionsApi.createQuestion).toHaveBeenCalled())
    expect(quizzesApi.createQuiz).not.toHaveBeenCalled()
    expect(conceptsApi.createConcept).not.toHaveBeenCalled()
    const [repId, input] = vi.mocked(questionsApi.createQuestion).mock.calls[0]
    expect(repId).toBe(8)
    expect(input.concept_id).toBe(2)
    expect(input.options.filter((o) => o.is_correct_answer).map((o) => o.option_text)).toEqual(['Cover 3'])
    fireEvent.click(await screen.findByRole('button', { name: 'Open rep' }))
    expect(path).toBe('/reps/8')
  })

  it('answers that are men in the play become spots the player taps', async () => {
    const play = open()
    fireEvent.click(within(screen.getByRole('group', { name: 'Quick answers' })).getByRole('button', { name: 'Players' }))
    expect(screen.getByText('Players tap the man in the picture.')).toBeInTheDocument()
    type('The situation', 'Who gets the ball?')
    fireEvent.click(screen.getByRole('button', { name: 'Make rep' }))
    await waitFor(() => expect(questionsApi.createQuestion).toHaveBeenCalled())
    const [, input] = vi.mocked(questionsApi.createQuestion).mock.calls[0]
    expect(input.tap_targets).toHaveLength(input.options.length)
    const x = play.players.find((p) => p.label === 'X')!
    const at = input.options.findIndex((o) => o.option_text === 'X')
    expect(input.tap_targets![at].x).toBeCloseTo(px(x).x / 1376)
    expect(input.tap_targets![at].y).toBeCloseTo(px(x).y / 720)
  })

  it('typed answers that are not men have no spots', async () => {
    open()
    type('The situation', 'Your check?')
    type('Answer 1', 'Rotate down')
    type('Answer 2', 'Stay boundary')
    expect(screen.queryByText('Players tap the man in the picture.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Make rep' }))
    await waitFor(() => expect(questionsApi.createQuestion).toHaveBeenCalled())
    expect(vi.mocked(questionsApi.createQuestion).mock.calls[0][1]).not.toHaveProperty('tap_targets')
  })

  it('cannot be made without a situation and two answers', () => {
    open()
    type('Answer 1', 'Rotate down')
    expect(screen.getByRole('button', { name: 'Make rep' })).toBeDisabled()
    type('The situation', 'Your check?')
    expect(screen.getByRole('button', { name: 'Make rep' })).toBeDisabled()
    type('Answer 2', 'Stay')
    expect(screen.getByRole('button', { name: 'Make rep' })).toBeEnabled()
  })
})
