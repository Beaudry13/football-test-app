// TESTS ONLY. How a test watches from another view.
//
// VIEW LIVES IN THE DOCK (first-30-seconds pass): one button beside Play that
// says what you are watching from, and a menu of the three. Overhead, Coach
// and Player used to be a segment in the top bar.

import { fireEvent, screen, within } from '@testing-library/react'

type ViewName = 'Overhead' | 'Coach' | 'Player'

const viewButton = () => within(document.querySelector('.bar.bottom') as HTMLElement).getByRole('button', { name: /^View / })

/** Open the dock's View menu and choose `name`. */
export function chooseView(name: ViewName) {
  fireEvent.click(viewButton())
  fireEvent.click(screen.getByRole('menuitemradio', { name }))
}

/** What the dock's View button says you are watching from. */
export const currentView = () =>
  viewButton()
    .textContent!.replace(/^View\s*/, '')
    .replace(/\s*▾$/, '')
