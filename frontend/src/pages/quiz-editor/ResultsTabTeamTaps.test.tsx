import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultsTab } from './ResultsTab';
import * as gradingApi from '../../api/grading';
import * as authContext from '../../auth/AuthContext';
import type { Quiz, QuizDashboard } from '../../api/types';

/**
 * WHERE DID EVERYBODY TAP? On normal quiz Results, a tap question shows the
 * team's choices on its football picture - the right spot green, every spot
 * someone chose with how many - the same TapResult a Rep reads back.
 */

const image = { id: 9, question_id: 5, image_url: '/uploads/play.png', annotations: [], canvas_width: null, updated_at: '' };

const quiz = {
  id: 1,
  title: 'Week 1',
  question_count: 2,
  questions: [
    {
      id: 5,
      quiz_id: 1,
      question_text: 'Who gets the ball?',
      question_type: 'multiple_choice',
      position: 0,
      image,
      tap_targets: [
        { x: 0.1, y: 0.5 },
        { x: 0.5, y: 0.5 },
        { x: 0.9, y: 0.5 },
      ],
      options: [
        { id: 10, question_id: 5, option_text: 'X', is_correct_answer: true, position: 0 },
        { id: 11, question_id: 5, option_text: 'H', is_correct_answer: false, position: 1 },
        { id: 12, question_id: 5, option_text: 'Z', is_correct_answer: false, position: 2 },
      ],
    },
    {
      id: 6,
      quiz_id: 1,
      question_text: 'Which coverage?',
      question_type: 'multiple_choice',
      position: 1,
      image: null,
      options: [
        { id: 20, question_id: 6, option_text: 'Cover 2', is_correct_answer: true, position: 0 },
        { id: 21, question_id: 6, option_text: 'Cover 3', is_correct_answer: false, position: 1 },
      ],
    },
  ],
} as unknown as Quiz;

const row = (id: number, n: number, text: string, counts: [number, string, boolean, number][]) => ({
  question_id: id,
  question_number: n,
  question_text: text,
  question_type: 'multiple_choice',
  answered_count: counts.reduce((t, c) => t + c[3], 0),
  correct_count: counts.filter((c) => c[2]).reduce((t, c) => t + c[3], 0),
  incorrect_count: counts.filter((c) => !c[2]).reduce((t, c) => t + c[3], 0),
  ungraded_count: 0,
  is_excluded: false,
  exclusions: [],
  concept: null,
  option_counts: counts.map(([option_id, option_text, is_correct, count]) => ({ option_id, option_text, is_correct, count })),
});

const dashboard = {
  quiz_id: 1,
  roster_size: 12,
  response_count: 12,
  response_rate: 1,
  missing_players: [],
  question_breakdown: [
    row(5, 1, 'Who gets the ball?', [
      [10, 'X', true, 8],
      [11, 'H', false, 1],
      [12, 'Z', false, 3],
    ]),
    row(6, 2, 'Which coverage?', [
      [20, 'Cover 2', true, 10],
      [21, 'Cover 3', false, 2],
    ]),
  ],
  concept_breakdown: [],
} as unknown as QuizDashboard;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(authContext, 'useAuth').mockReturnValue({ coach: { id: 1, role: 'member' } } as never);
  vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(dashboard);
  vi.spyOn(gradingApi, 'listResponses').mockResolvedValue([]);
});

describe('Results: where did everybody tap?', () => {
  it('a tap question shows the team on its picture - the right spot, every choice and how many', async () => {
    render(
      <MemoryRouter>
        <ResultsTab quiz={quiz} />
      </MemoryRouter>,
    );
    const taps = within(await screen.findByRole('region', { name: 'Where they tapped' }));
    expect(taps.getByText('Who gets the ball?')).toBeInTheDocument();
    expect(taps.getByRole('button', { name: 'Tap X' }).className).toMatch(/right/);
    expect(taps.getByRole('button', { name: 'Tap Z' }).className).toMatch(/wrong/);
    expect(taps.getByRole('button', { name: 'Tap Z' })).toHaveTextContent('3');
    expect(taps.getByText(/✓ X 8 \(67%\)/)).toBeInTheDocument();
    expect(taps.getByText(/Z 3 \(25%\)/)).toBeInTheDocument();
    expect(taps.getByText(/H 1 \(8%\)/)).toBeInTheDocument();
    // A question without tap spots stays in the table only.
    expect(taps.queryByText('Which coverage?')).toBeNull();
  });
});
