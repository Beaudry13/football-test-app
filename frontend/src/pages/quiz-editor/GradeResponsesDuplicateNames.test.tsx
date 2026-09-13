/** Question-first grading, with two players called John Smith.
 *
 * The screen used to receive nothing but a name for each answer, so two John
 * Smiths were two identical rows and a coach could not tell whose "Flat" was
 * whose. Attempt mode: jersey only. The verdict is still written against the
 * ANSWER the row belongs to - that is what the click test proves.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GradeResponsesPage } from './GradeResponsesPage';
import type { PlayerResponse, Quiz, QuizDashboard } from '../../api/types';

vi.mock('../../api/quizzes', () => ({ getQuiz: vi.fn() }));
vi.mock('../../api/grading', () => ({
  listResponses: vi.fn(),
  getQuizDashboard: vi.fn(),
  gradeAnswer: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../components/drawing/DrawingViewer', () => ({
  DrawingViewer: ({ alt }: { alt: string }) => <div data-testid="drawing">{alt}</div>,
}));

import { getQuiz } from '../../api/quizzes';
import { getQuizDashboard, gradeAnswer, listResponses } from '../../api/grading';

const WRITTEN_Q = 11;
const QB_ANSWER = 101;
const LB_ANSWER = 102;
const MIKE_ANSWER = 103;

const quiz = {
  id: 1,
  title: 'Install',
  questions: [
    {
      id: WRITTEN_Q,
      question_text: 'What is your responsibility in Cover 3?',
      question_type: 'written',
      expected_answers: [],
      options: [],
    },
  ],
} as unknown as Quiz;

const answer = (id: number, text: string) => ({
  id,
  question_id: WRITTEN_Q,
  answer_text: text,
  selected_option_id: null,
  is_correct: null,
  coach_feedback: null,
  graded_at: null,
  graded_by_username: null,
});

const responses = [
  {
    id: 1,
    player_id: 21,
    jersey_number: '12',
    display_name: 'John Smith',
    player_name: 'John Smith',
    answers: [answer(QB_ANSWER, 'Flat')],
    delivered_questions: [],
  },
  {
    id: 2,
    player_id: 22,
    jersey_number: '37',
    display_name: 'John Smith',
    player_name: 'John Smith',
    answers: [answer(LB_ANSWER, 'Deep third')],
    delivered_questions: [],
  },
  {
    id: 3,
    player_id: null,
    jersey_number: null,
    display_name: 'Mike Beaudry',
    player_name: 'Mike Beaudry',
    answers: [answer(MIKE_ANSWER, 'Hook')],
    delivered_questions: [],
  },
] as unknown as PlayerResponse[];

const dashboard = {
  quiz_id: 1,
  question_breakdown: [
    { question_id: WRITTEN_Q, is_excluded: false, ungraded_count: 3, question_type: 'written' },
  ],
  concept_breakdown: [],
  verification: null,
} as unknown as QuizDashboard;

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/quizzes/1/grade']}>
      <Routes>
        <Route path="/quizzes/:quizId/grade" element={<GradeResponsesPage />} />
        <Route path="/quizzes/:quizId" element={<div>RESULTS</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getQuiz).mockResolvedValue(quiz);
  vi.mocked(listResponses).mockResolvedValue(responses);
  vi.mocked(getQuizDashboard).mockResolvedValue(dashboard);
  vi.mocked(gradeAnswer).mockResolvedValue({} as never);
});

describe('grading same-named players', () => {
  it('labels them by jersey, with no position', async () => {
    renderPage();

    expect(await screen.findByText('John Smith · #12')).toBeInTheDocument();
    expect(screen.getByText('John Smith · #37')).toBeInTheDocument();
    expect(screen.getByText('Mike Beaudry')).toBeInTheDocument();
  });

  it('a verdict is written against THAT row’s answer', async () => {
    const user = userEvent.setup();
    renderPage();

    const lbRow = (await screen.findByText('John Smith · #37')).closest('li') as HTMLElement;
    expect(lbRow).toHaveTextContent('Deep third');

    await user.click(within(lbRow).getByRole('button', { name: /✓ Correct/ }));

    await waitFor(() => expect(gradeAnswer).toHaveBeenCalledTimes(1));
    expect(vi.mocked(gradeAnswer).mock.calls[0][0]).toBe(LB_ANSWER);
  });
});
