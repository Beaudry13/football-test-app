/** "Who missed it", with two players called John Smith.
 *
 * Attempt mode: jersey only. The position already shown beside each name is
 * `position_at_attempt`, and it must stay separate from the label rather than
 * being merged with anything live.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/retests', () => ({ createRetest: vi.fn() }));

import { WeakestConcepts } from './WeakestConcepts';
import type { ConceptBreakdown, ConceptMissingPlayer } from '../../api/types';

const concept = (players_missed: ConceptMissingPlayer[]): ConceptBreakdown => ({
  concept_id: 1,
  concept_name: 'Force / Contain',
  question_count: 2,
  correct_count: 16,
  incorrect_count: 6,
  ungraded_count: 0,
  graded_count: 22,
  miss_rate: 27.3,
  players_missed_count: players_missed.length,
  players_responded_count: 10,
  player_miss_rate: 60,
  retestable_question_count: 2,
  retired_missed_question_count: 0,
  has_enough_responses: true,
  players_missed,
  top_distractor: null,
});

function renderPanel(missed: ConceptMissingPlayer[]) {
  render(
    <MemoryRouter>
      <WeakestConcepts quizId={9} concepts={[concept(missed)]} />
    </MemoryRouter>,
  );
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

const SMITHS: ConceptMissingPlayer[] = [
  { player_id: 21, player_name: 'John Smith', display_name: 'John Smith', position_at_attempt: 'CB', jersey_number: '12' },
  { player_id: 22, player_name: 'John Smith', display_name: 'John Smith', position_at_attempt: 'S', jersey_number: '37' },
  { player_id: 30, player_name: 'Mike Beaudry', display_name: 'Mike Beaudry', position_at_attempt: 'CB', jersey_number: '4' },
];

describe('who missed it', () => {
  it('labels same-named players by jersey only', () => {
    renderPanel(SMITHS);

    // getByText matches an element's OWN text, so the position_at_attempt
    // chip beside each name is not part of these strings - which is the point.
    expect(screen.getByText('John Smith · #12')).toBeInTheDocument();
    expect(screen.getByText('John Smith · #37')).toBeInTheDocument();
  });

  it('keeps position_at_attempt in its own chip, unchanged', () => {
    renderPanel(SMITHS);

    const qbRow = screen.getByText('John Smith · #12').closest('li') as HTMLElement;
    expect(qbRow.textContent).toBe('John Smith · #12CB');
  });

  it('leaves a unique name untouched', () => {
    renderPanel(SMITHS);

    expect(screen.getByText('Mike Beaudry')).toBeInTheDocument();
    expect(screen.queryByText(/Mike Beaudry ·/)).toBeNull();
  });

  it('keys rows by the person, so two John Smiths do not share a React key', () => {
    renderPanel(SMITHS);

    const duplicateKeyWarnings = consoleError.mock.calls.filter((call: unknown[]) =>
      call.some((arg) => typeof arg === 'string' && /same key/i.test(arg)),
    );
    expect(duplicateKeyWarnings).toEqual([]);
  });
});
