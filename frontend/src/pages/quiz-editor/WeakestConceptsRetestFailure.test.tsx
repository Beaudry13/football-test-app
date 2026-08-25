import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { WeakestConcepts } from './WeakestConcepts';
import type { ConceptBreakdown } from '../../api/types';

vi.mock('../../api/retests', () => ({ createRetest: vi.fn() }));
import { createRetest } from '../../api/retests';

const c: ConceptBreakdown = {
  concept_id: 1, concept_name: 'Force / Contain', question_count: 2,
  correct_count: 16, incorrect_count: 6, ungraded_count: 0, graded_count: 22,
  miss_rate: 27.3, has_enough_responses: true,
  players_missed_count: 1, players_responded_count: 10, player_miss_rate: 10,
  retestable_question_count: 2, retired_missed_question_count: 0,
  players_missed: [{ player_id: 3, player_name: 'A', display_name: 'A', position_at_attempt: null }],
  top_distractor: null,
};

/** The Retest failure path, in a file of its own - and that is the fix.
 *
 * This assertion belongs beside the other Retest tests and spent a while
 * failing there: the runner reported the mocked rejection as an unhandled
 * error before the assertion could run, through three different shapes of
 * rejected promise. The component was never the problem - it catches, and the
 * identical pattern passed in isolation every time.
 *
 * Narrowing it down: the same component, the same mock and the same rejection
 * pass here, alone. So the interference is file-level mock state shared with
 * the other Retest tests, not anything about the component or the rejection.
 * Rather than reshape production code to satisfy a runner, or leave the
 * behaviour covered only by a browser check, the test moved to where it can
 * state the truth plainly.
 *
 * What it protects: a coach whose retest is refused stays on Results, is told
 * why, and is not handed a half-made quiz.
 */
describe('when Peira cannot build the retest', () => {
  it('shows why, and leaves the coach on Results with no draft created', async () => {
    vi.mocked(createRetest).mockImplementation(async () => { throw new Error('nope'); });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/a']}>
        <Routes>
          <Route path="/a" element={<WeakestConcepts quizId={9} concepts={[c]} />} />
          <Route path="/quizzes/:id" element={<div>EDITOR</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('button', { name: 'Retest this player' }));
    await user.click(screen.getByRole('button', { name: 'Create retest' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByText('EDITOR')).not.toBeInTheDocument();
  });
});
