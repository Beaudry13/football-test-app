import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { WeakestConcepts } from './WeakestConcepts';
import type { ConceptBreakdown, Question } from '../../api/types';

/**
 * RESULTS -> TEACH. Beside Retest, "Teach it" puts the concept's questions on
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
    open([question]);
    await userEvent.click(screen.getByRole('button', { name: 'Teach it' }));
    const teach = within(screen.getByRole('dialog', { name: 'Teach Force / Contain' }));
    expect(teach.getByText('Who has force on toss?')).toBeInTheDocument();
    expect(teach.getByText('The corner')).toBeInTheDocument();
    expect(teach.getByText('Corner squeezes, keeps it inside.')).toBeInTheDocument();
    expect(teach.getByText('4 chose “Spill”')).toBeInTheDocument();
    expect(teach.getByRole('img', { name: 'The play' })).toHaveAttribute('src', expect.stringContaining('/uploads/toss.png'));
    expect(teach.getByRole('link', { name: 'Open the play in Motion Lab' })).toHaveAttribute('href', '/motion-lab/plays/14');
  });

  it('is not offered when the questions are not to hand', () => {
    open([]);
    expect(screen.queryByRole('button', { name: 'Teach it' })).toBeNull();
  });
});
