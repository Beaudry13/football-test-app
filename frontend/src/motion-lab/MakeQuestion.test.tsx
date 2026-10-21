import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

vi.mock('../api/quizzes', () => ({ listQuizzes: vi.fn(), createQuiz: vi.fn() }))
vi.mock('../api/questions', () => ({ createQuestion: vi.fn() }))
vi.mock('../api/concepts', () => ({
  listConcepts: vi.fn(async () => [{ id: 7, name: 'Quick game', is_archived: false }]),
  createConcept: vi.fn(async (name: string) => ({ id: 99, name, is_archived: false })),
}))
// jsdom cannot draw; the picture itself is playImage's business, not this panel's.
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
import { MakeQuestion } from './MakeQuestion'
import { newPlay, type Play } from './engine/play'
import { px } from './playImageLayout'

/**
 * MOTION LAB -> QUIZ. The play on the field becomes a quiz question in one
 * click: a Draw question on a picture of the formation (routes hidden), or -
 * when the play gives someone the ball - "Who gets the ball?" with the play's
 * own target as the answer. It lands in the chosen quiz (or a new one named
 * after the play) and the quiz editor opens on it.
 */

let lastPath = ''
function PathProbe() {
  lastPath = useLocation().pathname
  return null
}

/** Jet motion by H, and routes after the snap. */
function withMotion(): Play {
  const play = newPlay('Jet')
  const h = play.players.find((p) => p.label === 'H')!
  h.motion = [{ x: h.x, y: h.y }, { x: h.x - 14, y: h.y }]
  const x = play.players.find((p) => p.label === 'X')!
  x.path = [{ x: x.x, y: x.y }, { x: x.x, y: 15 }]
  return play
}

const passTo = (targetId: string): Play => ({ ...newPlay('Jet Dig'), ball: { kind: 'pass', targetId, catchPoint: { x: 17, y: 11 } } })

function open(play: Play, motionPlayId: number | null = null) {
  const onClose = vi.fn()
  render(
    <MemoryRouter initialEntries={['/motion-lab']}>
      <PathProbe />
      <Routes>
        <Route path="/motion-lab" element={<MakeQuestion play={play} motionPlayId={motionPlayId} onClose={onClose} />} />
        <Route path="/quizzes/:quizId" element={<div>quiz editor</div>} />
      </Routes>
    </MemoryRouter>,
  )
  return onClose
}

const QUIZZES = [
  { id: 4, title: 'Week 3 install', question_count: 6, updated_at: '2026-10-01T00:00:00Z' },
  { id: 9, title: 'Red zone', question_count: 2, updated_at: '2026-10-10T00:00:00Z' },
]

beforeEach(() => {
  vi.clearAllMocks()
  lastPath = ''
  vi.mocked(quizzesApi.listQuizzes).mockResolvedValue(QUIZZES as never)
  vi.mocked(quizzesApi.createQuiz).mockResolvedValue({ id: 31 } as never)
  vi.mocked(questionsApi.createQuestion).mockResolvedValue({ id: 500 } as never)
})

describe('create once, teach everywhere', () => {
  it("carries the concept he already named for this play's Rep decisions, and his point", async () => {
    const play = newPlay('Trips Right Smash')
    localStorage.setItem(
      'peira.makeRep.v1',
      JSON.stringify({ playId: play.id, who: null, role: '', concept: 'Quick game', repId: null, recentConcepts: ['Quick game'] }),
    )
    open(play)
    expect(screen.getByRole('textbox', { name: /Concept/ })).toHaveValue('Quick game')
    fireEvent.change(screen.getByRole('textbox', { name: /Why/ }), { target: { value: 'Beat the corner inside.' } })
    await waitFor(() => expect(conceptsApi.listConcepts).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Make question' }))
    await waitFor(() => expect(questionsApi.createQuestion).toHaveBeenCalled())
    const [, input] = vi.mocked(questionsApi.createQuestion).mock.calls[0]
    // The team's concept, matched by name - no duplicate made.
    expect(input).toMatchObject({ concept_id: 7, answer_explanation: 'Beat the corner inside.' })
    expect(conceptsApi.createConcept).not.toHaveBeenCalled()
    localStorage.removeItem('peira.makeRep.v1')
  })

  it("names the man a Draw question tests, so Teach and a Rep made from it ring him", async () => {
    const play = withMotion()
    const x = play.players.find((p) => p.label === 'X')!
    open(play)
    fireEvent.change(screen.getByRole('combobox', { name: /Whose job/ }), { target: { value: x.id } })
    fireEvent.click(screen.getByRole('button', { name: 'Make question' }))
    await waitFor(() => expect(questionsApi.createQuestion).toHaveBeenCalled())
    expect(vi.mocked(questionsApi.createQuestion).mock.calls[0][1]).toMatchObject({ subject_man: x.id })
  })
})

describe('Make a quiz question from a play', () => {
  it('makes a Draw question on a picture of the formation, in a new quiz named after the play, and opens it', async () => {
    open(newPlay('Trips Right Smash'))
    expect(screen.getByRole('radio', { name: 'Draw your assignment' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('radio', { name: 'Who gets the ball?' })).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Show the routes' })).not.toBeChecked()
    // No pre-snap motion in this play, so there is nothing to play.
    expect(screen.queryByRole('checkbox', { name: 'Play the motion' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Make question' }))
    await waitFor(() => expect(lastPath).toBe('/quizzes/31'))
    expect(quizzesApi.createQuiz).toHaveBeenCalledWith({ title: 'Trips Right Smash' })
    const [quizId, input, file] = vi.mocked(questionsApi.createQuestion).mock.calls[0]
    expect(quizId).toBe(31)
    expect(input).toEqual({
      question_text: 'Draw your assignment on this play.',
      question_type: 'draw_response',
      options: [],
      concept_id: null,
      answer_explanation: null,
    })
    expect((file as File).type).toBe('image/png')
    expect((file as File).name).toBe('Trips-Right-Smash.png')
    expect(vi.mocked(image.playImage).mock.calls[0][1]).toEqual({ routes: false })
  })

  it("Draw your assignment: the man's route in the play becomes the answer drawing - never drawn twice", async () => {
    const play = withMotion()
    const x = play.players.find((p) => p.label === 'X')!
    open(play)
    fireEvent.change(screen.getByRole('combobox', { name: /Whose job/ }), { target: { value: x.id } })
    expect(screen.getByRole('note')).toHaveTextContent('His route in this play becomes the answer')
    fireEvent.click(screen.getByRole('button', { name: 'Make question' }))
    await waitFor(() => expect(questionsApi.createQuestion).toHaveBeenCalled())
    const [, input] = vi.mocked(questionsApi.createQuestion).mock.calls[0]
    const answer = (input as { answer_drawing: { strokes: { id: string; layer: string; points: number[] }[] } }).answer_drawing
    expect(answer.strokes.map((s) => s.id)).toEqual(['route', 'arrow2', 'arrow3'])
    expect(answer.strokes.every((s) => s.layer === 'coach')).toBe(true)
    // The route starts on the man, in the picture's coordinate space.
    expect(answer.strokes[0].points.length).toBeGreaterThanOrEqual(4)
  })

  it('a man with no route in the play gets no answer drawing - nothing is guessed', async () => {
    const play = withMotion()
    const h = play.players.find((p) => p.label === 'H')!
    open(play)
    fireEvent.change(screen.getByRole('combobox', { name: /Whose job/ }), { target: { value: h.id } })
    expect(screen.getByRole('note')).toHaveTextContent('He has no route in this play')
    fireEvent.click(screen.getByRole('button', { name: 'Make question' }))
    await waitFor(() => expect(questionsApi.createQuestion).toHaveBeenCalled())
    expect('answer_drawing' in (vi.mocked(questionsApi.createQuestion).mock.calls[0][1] as object)).toBe(false)
  })

  it('"Who gets the ball?" offers the receivers and backs, answers with the play\'s target, and shows the routes', async () => {
    open(passTo('O8'))
    fireEvent.click(screen.getByRole('radio', { name: 'Who gets the ball?' }))
    expect(screen.getByRole('checkbox', { name: 'Show the routes' })).toBeChecked()
    await waitFor(() => expect(within(screen.getByRole('combobox')).getAllByRole('option')).toHaveLength(3))
    // Most recently changed quiz first, after "a new quiz".
    expect(within(screen.getByRole('combobox')).getAllByRole('option').map((o) => o.textContent)).toEqual(['A new quiz: “Jet Dig”', 'Red zone (2)', 'Week 3 install (6)'])
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make question' }))
    await waitFor(() => expect(lastPath).toBe('/quizzes/4'))
    expect(quizzesApi.createQuiz).not.toHaveBeenCalled()
    const [, input] = vi.mocked(questionsApi.createQuestion).mock.calls[0]
    expect(input.question_type).toBe('multiple_choice')
    expect(input.question_text).toBe('Who gets the ball on this play?')
    // The default offense's skill men: Y, RB, X, H, Z - never the QB or the line.
    expect(input.options.map((o) => o.option_text)).toEqual(['Y', 'RB', 'X', 'H', 'Z'])
    expect(input.options.filter((o) => o.is_correct_answer).map((o) => o.option_text)).toEqual(['X'])
    expect(vi.mocked(image.playImage).mock.calls[0][1]).toEqual({ routes: true })
  })

  it('names the man a Draw question is about - picked or tapped - ringed in the picture and named in the words', async () => {
    const play = newPlay('Jet Dig')
    open(play)
    const whose = screen.getByRole('combobox', { name: /Whose job/ })
    const words = screen.getByRole('textbox', { name: 'Question' })
    fireEvent.change(whose, { target: { value: 'O8' } })
    expect(words).toHaveValue("You're the X. Draw your assignment.")
    expect(vi.mocked(image.drawPlay).mock.lastCall![2]).toEqual({ routes: false, highlight: 'O8' })

    // A tap on a man in the picture makes it his question; a second tap lets go.
    const picture = screen.getByLabelText('The picture players will see')
    picture.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1376, height: 720, right: 1376, bottom: 720, x: 0, y: 0, toJSON: () => ({}) })
    const rb = play.players.find((p) => p.label === 'RB')!
    fireEvent.click(picture, { clientX: px(rb).x + 6, clientY: px(rb).y - 4 })
    expect(whose).toHaveValue(rb.id)
    expect(words).toHaveValue("You're the RB. Draw your assignment.")
    fireEvent.click(picture, { clientX: px(rb).x, clientY: px(rb).y })
    expect(whose).toHaveValue('')
    expect(words).toHaveValue('Draw your assignment on this play.')

    fireEvent.change(whose, { target: { value: 'O8' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make question' }))
    await waitFor(() => expect(lastPath).toBe('/quizzes/31'))
    const [, input] = vi.mocked(questionsApi.createQuestion).mock.calls[0]
    expect(input.question_text).toBe("You're the X. Draw your assignment.")
    expect(vi.mocked(image.playImage).mock.calls[0][1]).toEqual({ routes: false, highlight: 'O8' })
  })

  it("keeps the coach's own words when he names a man", () => {
    open(newPlay('Jet Dig'))
    const words = screen.getByRole('textbox', { name: 'Question' })
    fireEvent.change(words, { target: { value: 'Show me your fit against this front.' } })
    fireEvent.change(screen.getByRole('combobox', { name: /Whose job/ }), { target: { value: 'D0' } })
    expect(words).toHaveValue('Show me your fit against this front.')
  })

  it('"Who gets the ball?" marks nobody', async () => {
    open(passTo('O8'))
    fireEvent.change(screen.getByRole('combobox', { name: /Whose job/ }), { target: { value: 'O9' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Who gets the ball?' }))
    expect(screen.queryByRole('combobox', { name: /Whose job/ })).toBeNull()
    expect(vi.mocked(image.drawPlay).mock.lastCall![2]).toEqual({ routes: true, highlight: null })
    fireEvent.click(screen.getByRole('button', { name: 'Make question' }))
    await waitFor(() => expect(questionsApi.createQuestion).toHaveBeenCalled())
    expect(vi.mocked(image.playImage).mock.calls[0][1]).toEqual({ routes: true })
  })

  it('"Who gets the ball?" is answered by tapping the man, as in a Rep', async () => {
    const play = passTo('O8')
    open(play)
    fireEvent.click(screen.getByRole('radio', { name: 'Who gets the ball?' }))
    expect(screen.getByText(/players tap the man in the picture/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Make question' }))
    await waitFor(() => expect(questionsApi.createQuestion).toHaveBeenCalled())
    const [, input] = vi.mocked(questionsApi.createQuestion).mock.calls[0]
    expect(input.tap_targets).toHaveLength(input.options.length)
    const x = play.players.find((p) => p.label === 'X')!
    const at = input.options.findIndex((o) => o.option_text === 'X')
    expect(input.tap_targets![at].x).toBeCloseTo(px(x).x / 1376)
  })

  it('the coach can try what a player taps before making it', async () => {
    open(passTo('O8'))
    fireEvent.click(screen.getByRole('radio', { name: 'Who gets the ball?' }))
    fireEvent.click(screen.getByRole('button', { name: 'See what they tap' }))
    const check = within(await screen.findByRole('dialog', { name: 'What your players tap' }))
    fireEvent.click(check.getByRole('button', { name: 'Tap X' }))
    expect(check.getByRole('status')).toHaveTextContent('That answers “X” - the right one.')
  })

  it('says what went wrong and stays open', async () => {
    vi.mocked(questionsApi.createQuestion).mockRejectedValue(new Error('The picture is too large.'))
    open(newPlay('Jet Dig'))
    fireEvent.click(screen.getByRole('button', { name: 'Make question' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The picture is too large.')
    expect(lastPath).toBe('/motion-lab')
    expect(screen.getByRole('button', { name: 'Make question' })).toBeEnabled()
  })

  it('a play with pre-snap motion plays it for the player, frozen at the moment the coach picks', async () => {
    const play = withMotion()
    const h = play.players.find((p) => p.label === 'H')!
    open(play, 14)
    expect(screen.getByRole('checkbox', { name: 'Play the motion' })).toBeChecked()
    const moments = within(screen.getByRole('radiogroup', { name: 'Decide at' }))
    expect(moments.getByRole('radio', { name: 'Snap' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(moments.getByRole('radio', { name: 'Mid-motion' }))
    fireEvent.click(screen.getByRole('button', { name: 'Make question' }))
    await waitFor(() => expect(questionsApi.createQuestion).toHaveBeenCalled())
    const [, input] = vi.mocked(questionsApi.createQuestion).mock.calls[0]
    expect(input.question_type).toBe('draw_response')
    expect((input.presnap as { freeze?: string }).freeze).toBe('mid')
    expect(input.motion_play_id).toBe(14)
    // The picture a drawing goes on is the play AT the moment: H part-way across, no routes.
    const [frame, options] = vi.mocked(image.playImage).mock.calls[0]
    expect(options).toMatchObject({ routes: false, motion: true })
    const hAt = frame.players.find((p) => p.id === h.id)!
    expect(hAt.x).toBeLessThan(h.x)
    expect(hAt.x).toBeGreaterThan(h.x - 14)
  })

  it('the play moving or a still with its routes - one or the other', async () => {
    open(withMotion())
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show the routes' }))
    expect(screen.getByRole('checkbox', { name: 'Play the motion' })).not.toBeChecked()
    expect(screen.queryByRole('radiogroup', { name: 'Decide at' })).toBeNull()
    // And back: the motion plays again, the routes go - then routes once more.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Play the motion' }))
    expect(screen.getByRole('checkbox', { name: 'Show the routes' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show the routes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Make question' }))
    await waitFor(() => expect(questionsApi.createQuestion).toHaveBeenCalled())
    expect(vi.mocked(questionsApi.createQuestion).mock.calls[0][1].presnap).toBeUndefined()
    expect(vi.mocked(image.playImage).mock.calls[0][1]).toEqual({ routes: true })
  })

  it('Cancel closes it', () => {
    const onClose = open(newPlay('Jet Dig'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})
