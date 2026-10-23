import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
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
import * as authModule from '../../auth/AuthContext';
import { QuestionsTab } from './QuestionsTab';

/** TEACH IT, BEFORE OR AFTER THE TEST: any question, on the meeting-room screen. */

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
  answer_explanation: 'Single high, corners bail.',
};

describe('Teach this, from the quiz editor', () => {
  it("puts the question, the right answer and the coach's reason on the big screen", async () => {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: false } } as never);
    render(
      <MemoryRouter>
        <QuestionsTab
          quiz={{ id: 500, title: 'Week 3', kind: 'QUIZ', questions: [question], question_count: 1 } as unknown as Quiz}
          reload={vi.fn(async () => undefined)}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions for question 1' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Teach this' }));
    const teach = within(screen.getByRole('dialog', { name: 'Teach Week 3' }));
    expect(teach.getByText('Cover 3')).toBeInTheDocument();
    expect(teach.getByText('Single high, corners bail.')).toBeInTheDocument();
  });

  it('a question made from a Motion Lab play opens the play, for a coach who has Motion Lab - and only then', async () => {
    const fromPlay = { ...question, motion_play_id: 14 };
    const quiz = { id: 500, title: 'Week 3', kind: 'QUIZ', questions: [fromPlay], question_count: 1 } as unknown as Quiz;
    const auth = vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: false } } as never);
    const { unmount } = render(
      <MemoryRouter>
        <QuestionsTab quiz={quiz} reload={vi.fn(async () => undefined)} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions for question 1' }));
    await screen.findByRole('menuitem', { name: 'Teach this' });
    expect(screen.queryByRole('menuitem', { name: 'Open the play' })).toBeNull();
    unmount();

    auth.mockReturnValue({ coach: { id: 1, is_platform_owner: true } } as never);
    render(
      <MemoryRouter initialEntries={['/quizzes/500']}>
        <Routes>
          <Route path="/quizzes/500" element={<QuestionsTab quiz={quiz} reload={vi.fn(async () => undefined)} />} />
          <Route path="/motion-lab/plays/14" element={<p>the play</p>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions for question 1' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open the play' }));
    expect(await screen.findByText('the play')).toBeInTheDocument();
  });

  it('opens on that question and the arrows walk the rest of the quiz', async () => {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: false } } as never);
    const second = { ...question, id: 2, question_text: 'Where is the force?', answer_explanation: 'The corner.', options: question.options.map((o) => ({ ...o, question_id: 2 })) };
    render(
      <MemoryRouter>
        <QuestionsTab
          quiz={{ id: 500, title: 'Week 3', kind: 'QUIZ', questions: [question, second], question_count: 2 } as unknown as Quiz}
          reload={vi.fn(async () => undefined)}
        />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions for question 2' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Teach this' }));
    const dialog = screen.getByRole('dialog', { name: 'Teach Week 3' });
    expect(within(dialog).getByText('Where is the force?')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    expect(within(dialog).getByText('Identify the coverage.')).toBeInTheDocument();
  });
});
