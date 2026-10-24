import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import * as authModule from '../../auth/AuthContext';
import * as retestsApi from '../../api/retests';
import { WeakestConcepts } from './WeakestConcepts';
import type { ConceptBreakdown, Question } from '../../api/types';

/**
 * RESULTS -> TEACH. Beside Retest, "Teach" puts the concept's questions on
 * the screen for the meeting room: the picture, the coach's right answer, the
 * reason, and what the misses chose.
 */

const concept = (over: Partial<ConceptBreakdown> = {}): ConceptBreakdown => ({
  concept_id: 1,
  concept_name: 'Force / Contain',
  question_count: 1,
  correct_count: 4,
  incorrect_count: 6,
  ungraded_count: 0,
  graded_count: 10,
  miss_rate: 60,
  players_missed_count: 6,
  players_responded_count: 10,
  player_miss_rate: 60,
  retestable_question_count: 1,
  retired_missed_question_count: 0,
  has_enough_responses: true,
  players_missed: [],
  top_distractor: { option_text: 'Spill', count: 4, of_misses: 6 },
  ...over,
});

const question = {
  id: 7,
  quiz_id: 9,
  question_text: 'Who has force on toss?',
  question_type: 'multiple_choice',
  position: 0,
  concept: { id: 1, name: 'Force / Contain', is_archived: false },
  image: { id: 1, question_id: 7, image_url: '/uploads/toss.png', annotations: null, canvas_width: null, updated_at: '' },
  options: [
    { id: 1, question_id: 7, option_text: 'The corner', position: 0, is_correct_answer: true },
    { id: 2, question_id: 7, option_text: 'Spill', position: 1, is_correct_answer: false },
  ],
  answer_explanation: 'Corner squeezes, keeps it inside.',
  motion_play_id: 14,
} as unknown as Question;

function open(questions: Question[]) {
  render(
    <MemoryRouter>
      <WeakestConcepts concepts={[concept()]} quizId={9} questions={questions} />
    </MemoryRouter>,
  );
}

describe('Teach, on Results', () => {
  it('shows the concept\'s question with the right answer, the reason and what the misses chose', async () => {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: true } } as never);
    open([question]);
    await userEvent.click(screen.getByRole('button', { name: 'Teach' }));
    const teach = within(screen.getByRole('dialog', { name: 'Teach Force / Contain' }));
    expect(teach.getByText('Who has force on toss?')).toBeInTheDocument();
    expect(teach.getByText('The corner')).toBeInTheDocument();
    expect(teach.getByText('Corner squeezes, keeps it inside.')).toBeInTheDocument();
    expect(teach.getByText('4 chose “Spill”')).toBeInTheDocument();
    expect(teach.getByRole('img', { name: 'The play' })).toHaveAttribute('src', expect.stringContaining('/uploads/toss.png'));
    expect(teach.getByRole('link', { name: 'Open the play' })).toHaveAttribute('href', '/motion-lab/plays/14');
  });

  it("arrives straight in Teach from Home's Next up (?teach=<concept>)", () => {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: true } } as never);
    render(
      <MemoryRouter>
        <WeakestConcepts concepts={[concept()]} quizId={9} questions={[question]} teachConceptId={1} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('dialog', { name: 'Teach Force / Contain' })).toBeInTheDocument();
  });

  it('retests the players who missed it right from the teaching screen', async () => {
    const created = vi.spyOn(retestsApi, 'createRetest').mockResolvedValue({ id: 77 } as never);
    const missed = [
      { player_id: 4, player_name: 'Bo Brown', display_name: 'Bo Brown', position_at_attempt: 'S', jersey_number: null },
      { player_id: null, player_name: 'Walk On', display_name: 'Walk On', position_at_attempt: null, jersey_number: null },
    ];
    render(
      <MemoryRouter initialEntries={['/quizzes/9']}>
        <Routes>
          <Route path="/quizzes/9" element={<WeakestConcepts concepts={[concept({ players_missed: missed as never })]} quizId={9} questions={[question]} />} />
          <Route path="/quizzes/77" element={<p>the retest draft</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Teach' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Teach Force / Contain' })).getByRole('button', { name: 'Retest the 2' }));
    expect(await screen.findByText('the retest draft')).toBeInTheDocument();
    expect(created).toHaveBeenCalledWith(9, { concept_id: 1, player_ids: [4], player_names: ['Walk On'] });
  });

  it('is not offered when the questions are not to hand', () => {
    open([]);
    expect(screen.queryByRole('button', { name: 'Teach' })).toBeNull();
  });
});
