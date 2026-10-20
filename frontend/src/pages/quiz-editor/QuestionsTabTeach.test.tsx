import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
    const teach = within(screen.getByRole('dialog', { name: 'Teach Identify the coverage.' }));
    expect(teach.getByText('Cover 3')).toBeInTheDocument();
    expect(teach.getByText('Single high, corners bail.')).toBeInTheDocument();
  });
});
