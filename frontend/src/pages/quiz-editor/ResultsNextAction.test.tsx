import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/reps', () => ({ makeRepFromQuiz: vi.fn(), addDecisions: vi.fn() }));
vi.mock('../../api/concepts', () => ({ listConceptQuestions: vi.fn() }));
vi.mock('../../api/roster', () => ({ addRosterMembers: vi.fn() }));
vi.mock('../../api/retests', () => ({ createRetest: vi.fn() }));
import * as repsApi from '../../api/reps';
import * as rosterApi from '../../api/roster';
import * as retestsApi from '../../api/retests';
import type { ConceptBreakdown, Question } from '../../api/types';
import { WeakestConcepts } from './WeakestConcepts';
import { MissActions } from './MissActions';
import { RetestAction } from './RetestAction';

/**
 * RESULTS -> THE NEXT ACTION, with no dead ends: every concept the team
 * missed can be retested from its own row, a retest opens ready to send (the
 * Send tab, which says who gets it), a Rep made from a missed question
 * goes to the players who missed it, and who missed it is one tap down.
 */

let landed = '';
function Landed() {
  const location = useLocation();
  landed = `${location.pathname}${location.search}`;
  return <div>EDITOR</div>;
}
function renderAt(ui: React.ReactElement) {
  return render(
    <MemoryRouter initialEntries={['/quizzes/9']}>
      <Routes>
        <Route path="/quizzes/9" element={ui} />
        <Route path="/quizzes/:id" element={<Landed />} />
        <Route path="/reps/:id" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

const concept = (over: Partial<ConceptBreakdown> = {}): ConceptBreakdown => ({
  concept_id: 1,
  concept_name: 'Force / Contain',
  question_count: 2,
  correct_count: 16,
  incorrect_count: 6,
  ungraded_count: 0,
  graded_count: 22,
  miss_rate: 27.3,
  players_missed_count: 0,
  players_responded_count: 10,
  player_miss_rate: 60,
  retestable_question_count: 2,
  retired_missed_question_count: 0,
  has_enough_responses: true,
  players_missed: [],
  top_distractor: null,
  ...over,
});
const missed = [
  { player_id: 3, player_name: 'Ty Adams', display_name: 'Ty Adams', jersey_number: null, position_at_attempt: 'S' },
  { player_id: 4, player_name: 'Bo Brown', display_name: 'Bo Brown', jersey_number: null, position_at_attempt: 'FS' },
] as unknown as ConceptBreakdown['players_missed'];

const question = {
  id: 7,
  quiz_id: 9,
  question_text: 'Who has force on toss?',
  question_type: 'multiple_choice',
  position: 0,
  concept: null,
  image: { id: 1, question_id: 7, image_url: '/uploads/toss.png', annotations: null, canvas_width: null, updated_at: '' },
  options: [
    { id: 1, question_id: 7, option_text: 'The corner', position: 0, is_correct_answer: true },
    { id: 2, question_id: 7, option_text: 'Spill', position: 1, is_correct_answer: false },
  ],
} as unknown as Question;

beforeEach(() => {
  vi.clearAllMocks();
  landed = '';
  vi.mocked(retestsApi.createRetest).mockResolvedValue({ id: 42 } as never);
  vi.mocked(repsApi.makeRepFromQuiz).mockResolvedValue({ id: 77 } as never);
});

describe('every concept the team missed can be retested from its own row', () => {
  it('builds the same concept retest the top card does, for exactly who missed it, and opens it ready to send', async () => {
    renderAt(
      <WeakestConcepts
        quizId={9}
        concepts={[
          concept({ concept_id: 1, concept_name: 'Force / Contain' }),
          concept({ concept_id: 2, concept_name: 'Run fit', players_missed_count: 2, players_missed: missed }),
        ]}
      />,
    );
    const row = screen.getByText('Run fit').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Retest the 2' }));
    await waitFor(() =>
      expect(retestsApi.createRetest).toHaveBeenCalledWith(9, { concept_id: 2, player_ids: [3, 4], player_names: [] }),
    );
    await screen.findByText('EDITOR');
    expect(landed).toBe('/quizzes/42?tab=activate');
  });

  it('a row whose missed questions were all stopped offers no retest it cannot build', () => {
    renderAt(
      <WeakestConcepts
        quizId={9}
        concepts={[concept(), concept({ concept_id: 2, concept_name: 'Run fit', players_missed_count: 2, players_missed: missed, retestable_question_count: 0 })]}
      />,
    );
    expect(within(screen.getByText('Run fit').closest('li')!).queryByRole('button', { name: /Retest/ })).toBeNull();
  });
});

describe('a retest opens ready to send', () => {
  it('the top card: one tap builds it and lands on the Send tab - nothing to confirm, nothing sent', async () => {
    renderAt(<RetestAction quizId={9} conceptId={1} targets={missed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retest the 2' }));
    await screen.findByText('EDITOR');
    expect(landed).toBe('/quizzes/42?tab=activate');
  });

  it('a question row: Retest {name} lands on the Send tab too', async () => {
    renderAt(
      <MissActions quizId={9} questions={[question]} title="Q3" repTitle="Install - Q3" retestTargets={[{ player_id: 3, player_name: 'Ty Adams' }]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retest Ty' }));
    await screen.findByText('EDITOR');
    expect(landed).toBe('/quizzes/42?tab=activate');
  });
});

describe('a missed question, then what', () => {
  it('Make a rep goes to the players who missed it', async () => {
    renderAt(
      <MissActions
        quizId={9}
        questions={[question]}
        title="Q3"
        repTitle="Install - Q3"
        retestTargets={[
          { player_id: 3, player_name: 'Ty Adams' },
          { player_id: null, player_name: 'Legacy Kid' },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make a rep for the 1' }));
    await waitFor(() => expect(rosterApi.addRosterMembers).toHaveBeenCalledWith(77, [3]));
    expect(landed).toBe('/reps/77');
  });

  it('who missed it is one tap down, each name opening the player', () => {
    renderAt(
      <MissActions
        quizId={9}
        questions={[question]}
        title="Q3"
        repTitle="Install - Q3"
        retestTargets={[{ player_id: 3, player_name: 'Ty Adams' }]}
        missed={[
          { player_id: 3, player_name: 'Ty Adams' },
          { player_id: null, player_name: 'Legacy Kid' },
        ]}
      />,
    );
    expect(screen.queryByText('Who missed it:')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByText('Who missed it:')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ty Adams' })).toHaveAttribute('href', '/roster/3');
    expect(screen.getByText(/Legacy Kid/)).toBeInTheDocument();
  });
});
