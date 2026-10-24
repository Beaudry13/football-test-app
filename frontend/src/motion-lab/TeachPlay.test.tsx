import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// jsdom cannot draw; the picture is playImage's business.
vi.mock('./playImage', () => ({
  IMAGE_WIDTH: 1376,
  IMAGE_HEIGHT: 720,
  drawPlay: vi.fn(),
  playImage: vi.fn(),
}))
import * as image from './playImage'
import { newPlay, type Play } from './engine/play'
import { px } from './playImageLayout'
import { TeachPlay } from './TeachPlay'

/**
 * MOTION LAB -> TEACH. Tap the man to watch, choose where the play stops, write
 * the coaching point - and the play goes full screen for the meeting room.
 */

function open(play: Play = newPlay('Trips Jet'), onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <TeachPlay play={play} onClose={onClose} />
    </MemoryRouter>,
  )
  return { play, onClose }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('Teach a play from Motion Lab', () => {
  it('tapping a man rings him and names who he is', () => {
    const { play } = open()
    const picture = screen.getByLabelText('The play - tap the man to watch')
    picture.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1376, height: 720, right: 1376, bottom: 720, x: 0, y: 0, toJSON: () => ({}) })
    const fs = play.players.find((p) => p.label === 'FS')!
    fireEvent.click(picture, { clientX: px(fs).x, clientY: px(fs).y })
    expect(screen.getByRole('textbox', { name: /You’re the/ })).toHaveValue('Free safety')
    expect(vi.mocked(image.drawPlay).mock.lastCall![2]).toMatchObject({ highlight: fs.id })
  })

  it('Teach puts the play and the coaching point on the full screen', () => {
    open()
    fireEvent.change(screen.getByRole('textbox', { name: 'The coaching point' }), {
      target: { value: 'Eyes on the motion man.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Teach' }))
    const screenView = within(screen.getByRole('dialog', { name: 'Teach Trips Jet' }))
    expect(screenView.getByText('Eyes on the motion man.')).toBeInTheDocument()
    expect(screenView.queryByText(/Open the play in Motion Lab/)).toBeNull()
    // Remembered on this device for the next time this play is taught.
    expect(Object.values({ ...localStorage })).toContain('Eyes on the motion man.')
  })

  it("the meeting-room screen keeps the keys: Motion Lab's shortcuts do not reach the play", () => {
    const editorKeys = vi.fn()
    window.addEventListener('keydown', editorKeys)
    open()
    fireEvent.click(screen.getByRole('button', { name: 'Teach' }))
    const dialog = screen.getByRole('dialog', { name: 'Teach Trips Jet' })
    expect(dialog).toHaveFocus()
    fireEvent.keyDown(dialog, { key: ' ' })
    expect(editorKeys).not.toHaveBeenCalled()
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Teach Trips Jet' })).toBeNull()
    window.removeEventListener('keydown', editorKeys)
  })
})
