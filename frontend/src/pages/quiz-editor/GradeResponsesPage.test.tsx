/** Question-first grading, tested as the coach experiences it.
 *
 * The queue's rules are proven in gradingQueue.test.ts against the pure
 * functions. This file covers what the screen does with them: what a coach
 * sees, what a click writes, and what happens to a decision afterwards.
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
// The drawing engine renders to canvas, which jsdom cannot. Stubbed to
// something identifiable so the tests can assert the drawing IS presented and
// which image it was drawn over, without asserting pixels.
vi.mock('../../components/drawing/DrawingViewer', () => ({
  DrawingViewer: ({ imageUrl, alt }: { imageUrl: string; alt: string }) => (
    <div data-testid="drawing" data-image={imageUrl}>
      {alt}
    </div>
  ),
}));

import { getQuiz } from '../../api/quizzes';
import { getQuizDashboard, gradeAnswer, listResponses } from '../../api/grading';

const WRITTEN_Q = 11;
const DRAW_Q = 12;
const AUTO_Q = 13;
const EXCLUDED_Q = 14;

const quiz = (): Quiz =>
  ({
    id: 1,
    title: 'Install Week 2',
    questions: [
      {
        id: AUTO_Q,
        question_text: 'Cover 3 or Cover 4?',
        question_type: 'multiple_choice',
        options: [],
      },
      {
        id: WRITTEN_Q,
        question_text: 'What is your responsibility in Cover 3?',
        question_type: 'written',
        expected_answers: ['Hook/curl', '#3 vertical'],
        options: [],
      },
      {
        id: DRAW_Q,
        question_text: 'Draw your drop.',
        question_type: 'draw_response',
        options: [],
      },
      {
        id: EXCLUDED_Q,
        question_text: 'Explain the check.',
        question_type: 'written',
        options: [],
      },
    ],
  }) as unknown as Quiz;

let answerId = 100;
const answer = (question_id: number, is_correct: boolean | null, text: string, drawing = false) => ({
  id: answerId++,
  question_id,
  answer_text: text,
  selected_option_id: null,
  is_correct,
  coach_feedback: null,
  graded_at: null,
  graded_by_username: null,
  ...(drawing ? { drawing: { id: 1, answer_id: 1, document: { strokes: [] }, revision: 1 } } : {}),
});

const responses = (): PlayerResponse[] =>
  [
    {
      id: 1,
      display_name: 'Mike Beaudry',
      player_name: 'Mike Beaudry',
      answers: [
        answer(WRITTEN_Q, null, 'Hook to curl, eyes on #3'),
        answer(DRAW_Q, null, '', true),
        answer(AUTO_Q, true, ''),
        answer(EXCLUDED_Q, null, 'Something'),
      ],
      delivered_questions: [
        { question_id: DRAW_Q, image: { image_url: '/uploads/drop.jpg' } },
      ],
    },
    {
      id: 2,
      display_name: 'John Smith',
      player_name: 'John Smith',
      answers: [answer(WRITTEN_Q, null, 'Flat')],
      delivered_questions: [],
    },
  ] as unknown as PlayerResponse[];

const dashboard = (excluded: number[] = [EXCLUDED_Q]): QuizDashboard =>
  ({
    quiz_id: 1,
    question_breakdown: [
      { question_id: AUTO_Q, is_excluded: false, ungraded_count: 0, question_type: 'multiple_choice' },
      { question_id: WRITTEN_Q, is_excluded: false, ungraded_count: 2, question_type: 'written' },
      { question_id: DRAW_Q, is_excluded: false, ungraded_count: 1, question_type: 'draw_response' },
      {
        question_id: EXCLUDED_Q,
        is_excluded: excluded.includes(EXCLUDED_Q),
        ungraded_count: 1,
        question_type: 'written',
      },
    ],
    concept_breakdown: [],
    verification: null,
  }) as unknown as QuizDashboard;

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
  answerId = 100;
  vi.mocked(getQuiz).mockResolvedValue(quiz());
  vi.mocked(listResponses).mockResolvedValue(responses());
  vi.mocked(getQuizDashboard).mockResolvedValue(dashboard());
  vi.mocked(gradeAnswer).mockResolvedValue({} as never);
});

describe('the question anchors the screen', () => {
  it('states the question once, however many answers there are', async () => {
    renderPage();

    // Two players answered it; the question is written on screen ONCE.
    // Repeating it per player would rebuild the context-switching cost this
    // screen exists to remove.
    const heading = await screen.findByRole('heading', {
      name: 'What is your responsibility in Cover 3?',
    });
    expect(heading).toBeInTheDocument();
    expect(screen.getAllByText('What is your responsibility in Cover 3?')).toHaveLength(1);
  });

  it('shows the accepted answers as the standard being applied', async () => {
    renderPage();

    expect(await screen.findByText('Hook/curl · #3 vertical')).toBeInTheDocument();
  });

  it('says which question this is and how much is left', async () => {
    renderPage();

    // Question 2 of the QUIZ - the auto-graded one is first - not "1 of 2".
    expect(await screen.findByText(/Question 2/)).toBeInTheDocument();
    expect(screen.getByText(/2 left/)).toBeInTheDocument();
    expect(screen.getByText(/3 left on this quiz/)).toBeInTheDocument();
  });

  it('lists every player who answered, with their answer', async () => {
    renderPage();

    expect(await screen.findByText('Mike Beaudry')).toBeInTheDocument();
    expect(screen.getByText('Hook to curl, eyes on #3')).toBeInTheDocument();
    expect(screen.getByText('John Smith')).toBeInTheDocument();
    expect(screen.getByText('Flat')).toBeInTheDocument();
  });
});

describe('making the call', () => {
  it('writes Correct through the existing grade endpoint', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');

    const row = screen.getByText('Hook to curl, eyes on #3').closest('li')!;
    await user.click(within(row).getByRole('button', { name: /Correct/ }));

    await waitFor(() =>
      expect(gradeAnswer).toHaveBeenCalledWith(100, { is_correct: true, coach_feedback: null }),
    );
  });

  it('writes Incorrect through the same endpoint', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('John Smith');

    const row = screen.getByText('Flat').closest('li')!;
    await user.click(within(row).getByRole('button', { name: /Incorrect/ }));

    await waitFor(() =>
      expect(gradeAnswer).toHaveBeenCalledWith(104, { is_correct: false, coach_feedback: null }),
    );
  });

  it('keeps a graded response on screen, marked', async () => {
    // A row that vanishes the instant it is decided makes a misclick
    // invisible at exactly the moment it is most likely.
    const graded = responses();
    graded[0].answers![0].is_correct = true;
    vi.mocked(listResponses).mockResolvedValue(graded);
    renderPage();

    await screen.findByText('Mike Beaudry');
    expect(screen.getByText('Hook to curl, eyes on #3')).toBeInTheDocument();
    const row = screen.getByText('Hook to curl, eyes on #3').closest('li')!;
    expect(within(row).getByRole('button', { name: /Correct/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('lets a coach change a decision they already made', async () => {
    const user = userEvent.setup();
    const graded = responses();
    graded[0].answers![0].is_correct = true;
    const alreadyGradedId = graded[0].answers![0].id;
    vi.mocked(listResponses).mockResolvedValue(graded);
    renderPage();
    await screen.findByText('Mike Beaudry');

    const row = screen.getByText('Hook to curl, eyes on #3').closest('li')!;
    await user.click(within(row).getByRole('button', { name: /Incorrect/ }));

    await waitFor(() =>
      expect(gradeAnswer).toHaveBeenCalledWith(alreadyGradedId, {
        is_correct: false,
        coach_feedback: null,
      }),
    );
  });

  it('never asks for confirmation', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');

    const row = screen.getByText('Flat').closest('li')!;
    await user.click(within(row).getByRole('button', { name: /Correct/ }));

    await waitFor(() => expect(gradeAnswer).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('drawings', () => {
  it('renders the drawing over the image that player was delivered', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');

    await user.click(screen.getByRole('button', { name: /Next question/ }));

    expect(await screen.findByRole('heading', { name: 'Draw your drop.' })).toBeInTheDocument();
    const drawing = screen.getByTestId('drawing');
    expect(drawing.getAttribute('data-image')).toContain('/uploads/drop.jpg');
  });

  it('grades a drawing with the same two buttons', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');
    await user.click(screen.getByRole('button', { name: /Next question/ }));
    await screen.findByRole('heading', { name: 'Draw your drop.' });

    const row = screen.getByTestId('drawing').closest('li')!;
    await user.click(within(row).getByRole('button', { name: /Correct/ }));

    await waitFor(() =>
      expect(gradeAnswer).toHaveBeenCalledWith(101, { is_correct: true, coach_feedback: null }),
    );
  });
});

describe('what is in the queue', () => {
  it('never shows an auto-graded question', async () => {
    renderPage();
    await screen.findByText('Mike Beaudry');

    expect(screen.queryByText('Cover 3 or Cover 4?')).not.toBeInTheDocument();
  });

  it("never shows a question marked don't count", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mike Beaudry');

    // Written, ungraded, answered - and still absent, because the coach
    // already said it does not count.
    expect(screen.queryByText('Explain the check.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Next question/ }));
    await screen.findByRole('heading', { name: 'Draw your drop.' });
    expect(screen.queryByText('Explain the check.')).not.toBeInTheDocument();
  });

  it('includes it once the coach restores the question', async () => {
    // The mirror of the rule: exclusion is what removes it, nothing else.
    vi.mocked(getQuizDashboard).mockResolvedValue(dashboard([]));
    renderPage();

    expect(await screen.findByText(/4 left on this quiz/)).toBeInTheDocument();
  });
});

describe('finishing', () => {
  it('shows a plain completion state when nothing is left', async () => {
    const allGraded = responses();
    allGraded[0].answers!.forEach((a) => (a.is_correct = true));
    allGraded[1].answers!.forEach((a) => (a.is_correct = true));
    vi.mocked(listResponses).mockResolvedValue(allGraded);
    renderPage();

    expect(await screen.findByRole('heading', { name: 'All caught up' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to results' })).toHaveAttribute(
      'href',
      '/quizzes/1',
    );
    // No statistics, no celebration.
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('says so plainly when a quiz has no hand-graded questions at all', async () => {
    vi.mocked(getQuiz).mockResolvedValue({
      id: 1,
      title: 'Auto only',
      questions: [{ id: AUTO_Q, question_text: 'A', question_type: 'multiple_choice', options: [] }],
    } as unknown as Quiz);
    renderPage();

    expect(await screen.findByText(/Nothing on this quiz needs grading by hand/)).toBeInTheDocument();
  });
});
