import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/reps', () => ({ makeRepFromQuiz: vi.fn() }));
vi.mock('../../api/roster', () => ({ addRosterMembers: vi.fn() }));
import * as repsApi from '../../api/reps';
import * as rosterApi from '../../api/roster';
import * as authModule from '../../auth/AuthContext';
import type { ConceptBreakdown, Question, QuestionBreakdown } from '../../api/types';
import { WeakestConcepts } from './WeakestConcepts';
import { MissActions } from './MissActions';

/**
 * A QUIZ MISS, THEN WHAT? Teach it on the football picture, or make it a Rep
 * for exactly the players who missed it - the football problem carried over,
 * nothing sent.
 */

const image = { id: 1, question_id: 7, image_url: '/uploads/toss.png', annotations: null, canvas_width: null, updated_at: '' };
const question = {
  id: 7,
  quiz_id: 9,
  question_text: 'Who has force on toss?',
  question_type: 'multiple_choice',
  position: 0,
  concept: { id: 1, name: 'Force / Contain', is_archived: false },
  image,
  options: [
    { id: 1, question_id: 7, option_text: 'The corner', position: 0, is_correct_answer: true },
    { id: 2, question_id: 7, option_text: 'Spill', position: 1, is_correct_answer: false },
    { id: 3, question_id: 7, option_text: 'The safety', position: 2, is_correct_answer: false },
  ],
  answer_explanation: 'Corner squeezes, keeps it inside.',
} as unknown as Question;

const row: QuestionBreakdown = {
  question_id: 7,
  question_number: 3,
  question_text: 'Who has force on toss?',
  question_type: 'multiple_choice',
  answered_count: 10,
  correct_count: 4,
  incorrect_count: 6,
  ungraded_count: 0,
  is_excluded: false,
  exclusions: [],
  option_counts: [
    { option_id: 1, option_text: 'The corner', is_correct: true, count: 4 },
    { option_id: 2, option_text: 'Spill', is_correct: false, count: 2 },
    { option_id: 3, option_text: 'The safety', is_correct: false, count: 4 },
  ],
} as unknown as QuestionBreakdown;

const concept = {
  concept_id: 1,
  concept_name: 'Force / Contain',
  question_count: 1,
  correct_count: 4,
  incorrect_count: 6,
  ungraded_count: 0,
  graded_count: 10,
  miss_rate: 60,
  players_missed_count: 2,
  players_responded_count: 10,
  player_miss_rate: 20,
  retestable_question_count: 1,
  retired_missed_question_count: 0,
  has_enough_responses: true,
  players_missed: [
    { player_id: 41, player_name: 'Ty Adams', display_name: 'Ty Adams', jersey_number: null, position_at_attempt: 'CB' },
    { player_id: 42, player_name: 'Bo Brown', display_name: 'Bo Brown', jersey_number: null, position_at_attempt: 'CB' },
  ],
  top_distractor: null,
} as unknown as ConceptBreakdown;

function at(ui: React.ReactNode) {
  render(
    <MemoryRouter initialEntries={['/quizzes/9']}>
      <Routes>
        <Route path="/quizzes/9" element={ui} />
        <Route path="/reps/:id" element={<p>the new rep</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1 } } as never);
  vi.mocked(repsApi.makeRepFromQuiz).mockResolvedValue({ id: 55 } as never);
  vi.mocked(rosterApi.addRosterMembers).mockResolvedValue({} as never);
});

describe('from a quiz miss', () => {
  it('a concept miss: Make a rep for the ones who missed it - the questions carried, those players on it', async () => {
    at(<WeakestConcepts concepts={[concept]} quizId={9} questions={[question]} breakdown={[row]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Make a rep for the 2' }));
    expect(await screen.findByText('the new rep')).toBeInTheDocument();
    expect(repsApi.makeRepFromQuiz).toHaveBeenCalledWith(9, [7], 'Force / Contain - Rep');
    expect(rosterApi.addRosterMembers).toHaveBeenCalledWith(55, [41, 42]);
  });

  it('Teach shows what the room chose most on that very question, from the counts', async () => {
    at(<MissActions quizId={9} questions={[question]} breakdown={[row]} title="Q3" repTitle="Week 3 - Q3" />);
    fireEvent.click(screen.getByRole('button', { name: 'Teach' }));
    const teach = within(screen.getByRole('dialog', { name: 'Teach Q3' }));
    expect(teach.getByText('The corner')).toBeInTheDocument();
    expect(teach.getByText('Corner squeezes, keeps it inside.')).toBeInTheDocument();
    expect(teach.getByText('4 chose “The safety”')).toBeInTheDocument();
    // Make rep right from the meeting room.
    fireEvent.click(teach.getByRole('button', { name: 'Make rep' }));
    await waitFor(() => expect(repsApi.makeRepFromQuiz).toHaveBeenCalledWith(9, [7], 'Week 3 - Q3'));
    expect(rosterApi.addRosterMembers).not.toHaveBeenCalled();
  });
});

describe('concept rows say the problem, or that it is fine', () => {
  it('a missed concept: what they chose instead and the next step; a clean one: Looks good', () => {
    const weakest = { ...concept, concept_id: 9, concept_name: 'Run fits', players_missed_count: 5, player_miss_rate: 50 };
    const missed = {
      ...concept,
      top_distractor: { option_text: 'Spill', count: 2, of_misses: 2 },
    };
    const clean = {
      ...concept,
      concept_id: 2,
      concept_name: 'Leverage',
      players_missed_count: 0,
      players_missed: [],
      player_miss_rate: 0,
    };
    at(
      <WeakestConcepts
        concepts={[weakest, missed, clean] as ConceptBreakdown[]}
        quizId={9}
        questions={[question, { ...question, id: 8, concept: { id: 2, name: 'Leverage', is_archived: false } } as Question]}
      />,
    );
    const force = screen.getByText('Force / Contain').closest('li')!;
    expect(within(force).getByText('Spill')).toBeInTheDocument();
    expect(within(force).getByRole('button', { name: 'Teach' })).toBeInTheDocument();
    const leverage = screen.getByText('Leverage').closest('li')!;
    expect(within(leverage).getByText('✓ Looks good')).toBeInTheDocument();
    expect(within(leverage).queryByRole('button', { name: 'Teach' })).toBeNull();
  });
});
