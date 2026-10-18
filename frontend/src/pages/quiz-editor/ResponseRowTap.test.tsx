/** A TAP ANSWER IN THE COACH'S RESULTS: his tap and the right spot, on the
 *  picture he tapped - one glance, the same football picture he answered on. */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ResponseRow } from './ResponseRow';
import * as authContext from '../../auth/AuthContext';
import type { Answer, DeliveredQuestion, PlayerResponse, Quiz } from '../../api/types';

const image = { id: 9, question_id: 5, image_url: '/uploads/play.png', annotations: [], canvas_width: null, updated_at: '' };

const liveQuestion = {
  id: 5,
  quiz_id: 1,
  question_text: 'Who gets the ball?',
  question_type: 'multiple_choice' as const,
  position: 0,
  allows_multiple_answers: false,
  image,
  tap_targets: [
    { x: 0.1, y: 0.5 },
    { x: 0.9, y: 0.5 },
  ],
  options: [
    { id: 10, question_id: 5, option_text: 'X (reworded)', is_correct_answer: true, position: 0 },
    { id: 20, question_id: 5, option_text: 'Z', is_correct_answer: false, position: 1 },
  ],
};

const quiz = { id: 1, title: 'Week 1', questions: [liveQuestion] } as unknown as Quiz;

const delivered: DeliveredQuestion = {
  question_id: 5,
  question_number: 1,
  question_text: 'Who gets the ball?',
  question_type: 'multiple_choice',
  allows_multiple_answers: false,
  options: [
    { id: 10, option_text: 'X', is_correct_answer: true },
    { id: 20, option_text: 'Z', is_correct_answer: false },
  ],
  image,
  from_snapshot: true,
};

const answer = (chose: number, right: boolean): Answer =>
  ({
    id: 100,
    question_id: 5,
    answer_text: null,
    selected_option_id: chose,
    selected_option_ids: [],
    is_correct: right,
    coach_feedback: null,
    graded_at: null,
    graded_by_username: null,
  }) as Answer;

async function expand(a: Answer) {
  render(
    <MemoryRouter>
      <ResponseRow
        quiz={quiz}
        response={
          {
            id: 7,
            quiz_id: 1,
            access_code_id: 9,
            player_name: 'Jordan Smith',
            display_name: 'Jordan Smith',
            submitted_at: '2026-01-01T00:05:00Z',
            answers: [a],
            delivered_questions: [delivered],
          } as PlayerResponse
        }
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: /expand answers/i }));
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(authContext, 'useAuth').mockReturnValue({ coach: { id: 1, role: 'member' } } as never);
});

describe('a tap answer in the results', () => {
  it('a miss: his tap in red, the right spot in green, and one line saying so', async () => {
    await expand(answer(20, false));
    expect(screen.getByRole('button', { name: 'Tap Z' }).className).toMatch(/wrong/);
    expect(screen.getByRole('button', { name: 'Tap X' }).className).toMatch(/right/);
    expect(screen.getByText(/✕ Tapped Z/)).toBeInTheDocument();
    expect(screen.getByText(/✓ X$/)).toBeInTheDocument();
  });

  it('a right answer: just the right spot, his', async () => {
    await expand(answer(10, true));
    expect(screen.getByRole('button', { name: 'Tap X' }).className).toMatch(/right/);
    expect(screen.getByRole('button', { name: 'Tap Z' }).className).not.toMatch(/wrong/);
    expect(screen.getByText('✓ Tapped X')).toBeInTheDocument();
  });
});
