import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { readFrom } from '../navigation/backTo'
import { CheckThem } from './CheckThem'

/**
 * TEACH -> CHECK THEM -> what is already made from the play. The Rep or quiz it
 * opens hands back the way to where the coach was teaching, so its back link
 * returns there instead of to the list.
 */

function Landed() {
  const from = readFrom(useLocation().state)
  return <p>{from ? `back to ${from.label} at ${from.to}` : 'no way back'}</p>
}

function open(linkState?: object | null) {
  render(
    <MemoryRouter initialEntries={['/motion-lab/plays/19']}>
      <Routes>
        <Route
          path="/motion-lab/plays/19"
          element={
            <CheckThem
              made={[
                { id: 7, kind: 'QUIZ', title: 'Jet motion' },
                { id: 5, kind: 'REP', title: 'Run fits' },
              ] as never}
              who={null}
              onMake={vi.fn()}
              linkState={linkState}
            />
          }
        />
        <Route path="/quizzes/7" element={<Landed />} />
        <Route path="/reps/5" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  )
  fireEvent.click(screen.getByRole('button', { name: /Check them/ }))
}

describe('Check them: what is made from this play', () => {
  it('opens the quiz with the way back to where he was teaching', () => {
    open({ from: { to: '/motion-lab/plays/19', label: 'Trips Jet' } })
    fireEvent.click(screen.getByRole('menuitem', { name: /Jet motion/ }))
    expect(screen.getByText('back to Trips Jet at /motion-lab/plays/19')).toBeInTheDocument()
  })

  it('opens the Rep the same way - back into an install meeting at its item', () => {
    open({ from: { to: '/installs/3?teach=1&at=2', label: 'Week 7' } })
    fireEvent.click(screen.getByRole('menuitem', { name: /Run fits/ }))
    expect(screen.getByText('back to Week 7 at /installs/3?teach=1&at=2')).toBeInTheDocument()
  })

  it('without a way back, the page keeps its own back link', () => {
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: /Jet motion/ }))
    expect(screen.getByText('no way back')).toBeInTheDocument()
  })
})
