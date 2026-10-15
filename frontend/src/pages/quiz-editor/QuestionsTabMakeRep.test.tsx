import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Quiz } from '../../api/types';

vi.mock('../../api/questions', () => ({
  createQuestion: vi.fn(),
  deleteQuestion: vi.fn(),
  reorderQuestions: vi.fn(),
  updateQuestion: vi.fn(),
  retireQuestion: vi.fn().mockResolvedValue({}),
  restoreQuestion: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../api/reps', () => ({ makeRepFromQuiz: vi.fn(), addDecisions: vi.fn() }));
import * as repsApi from '../../api/reps';
import * as quizzesApi from '../../api/quizzes';
import * as authModule from '../../auth/AuthContext';
import { QuestionsTab } from './QuestionsTab';

/**
 * EXISTING CONTENT -> SITUATIONAL REP. One tap in the quiz editor copies the
 * quiz's tap-an-answer questions into a new Rep and opens it - for every
 * coach. A Rep does not offer to become a Rep.
 */

const question = {
  id: 1,
  quiz_id: 500,
  question_text: 'Identify the coverage.',
  question_type: 'multiple_choice',
  position: 0,
  options: [
    { id: 1, question_id: 1, option_text: 'Cover 3', position: 0, is_correct_answer: true },
    { id: 2, question_id: 1, option_text: 'Cover 2', position: 1, is_correct_answer: false },
  ],
  image: null,
  concept: null,
};
const quiz = (kind: 'QUIZ' | 'REP' = 'QUIZ') =>
  ({ id: 500, title: 'Week 3', kind, questions: [question], question_count: 1 }) as unknown as Quiz;

function open(owner: boolean, kind: 'QUIZ' | 'REP' = 'QUIZ') {
  vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: owner } } as never);
  render(
    <MemoryRouter initialEntries={['/quizzes/500']}>
      <Routes>
        <Route path="/quizzes/500" element={<QuestionsTab quiz={quiz(kind)} reload={vi.fn(async () => undefined)} />} />
        <Route path="/reps/:id" element={<p>the rep</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(repsApi.makeRepFromQuiz).mockReset().mockResolvedValue({ id: 77, left_behind: 0 } as never);
});

describe('Make a rep, in the quiz editor', () => {
  it('copies the quiz into a new Rep and opens it', async () => {
    open(true);
    fireEvent.click(screen.getByRole('button', { name: 'Make a rep' }));
    expect(await screen.findByText('the rep')).toBeInTheDocument();
    expect(repsApi.makeRepFromQuiz).toHaveBeenCalledWith(500);
  });

  it('says why when the quiz has nothing a Rep can judge', async () => {
    vi.mocked(repsApi.makeRepFromQuiz).mockRejectedValue(new Error('This quiz has no tap-an-answer questions'));
    open(true);
    fireEvent.click(screen.getByRole('button', { name: 'Make a rep' }));
    expect(await screen.findByText('This quiz has no tap-an-answer questions')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Make a rep' })).toBeEnabled());
  });

  it('is offered to every coach, Motion Lab or not', () => {
    open(false);
    expect(screen.getByRole('button', { name: 'Make a rep' })).toBeInTheDocument();
  });

  it('one question becomes a new rep from its own menu', async () => {
    open(false);
    fireEvent.click(screen.getByRole('button', { name: 'More actions for question 1' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Make a rep from this' }));
    expect(await screen.findByText('the rep')).toBeInTheDocument();
    expect(repsApi.makeRepFromQuiz).toHaveBeenCalledWith(500, [1]);
  });

  it('one question goes into a rep that already exists', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([
      { id: 9, title: 'Trips Jet - Boundary safety', kind: 'REP', question_count: 2, updated_at: '2026-10-15' },
      { id: 3, title: 'Another quiz', kind: 'QUIZ', question_count: 4, updated_at: '2026-10-14' },
    ] as never);
    vi.mocked(repsApi.addDecisions).mockResolvedValue({ id: 9, added: 1 } as never);
    open(false);
    fireEvent.click(screen.getByRole('button', { name: 'More actions for question 1' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Add to a rep…' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add to a rep' }));
    expect(dialog.queryByRole('button', { name: /Another quiz/ })).toBeNull();
    fireEvent.click(await dialog.findByRole('button', { name: /Trips Jet - Boundary safety/ }));
    expect(await screen.findByText('the rep')).toBeInTheDocument();
    expect(repsApi.addDecisions).toHaveBeenCalledWith(9, 500, [1]);
  });

  it('is not offered on something that is already a Rep', () => {
    open(true, 'REP');
    expect(screen.queryByRole('button', { name: 'Make a rep' })).toBeNull();
  });
});
