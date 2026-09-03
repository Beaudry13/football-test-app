import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuizEditorPage } from './QuizEditorPage';
import type { Quiz } from '../../api/types';

/** A SAVED QUESTION MUST NEVER VANISH FROM THE BUILDER.
 *
 * REPORTED FROM REAL USE: a coach added a question with a screen recording,
 * saw it in the builder, went to activate the quiz - and the question was gone.
 *
 * THE CAUSE HAS NOTHING TO DO WITH RECORDINGS. `PATCH /api/quizzes/:id` returns
 * the quiz WITHOUT its questions - `to_dict()` only adds that key when asked -
 * and the editor did `setQuiz(updated)`, replacing a complete quiz with a
 * partial one. `QuestionsTab` then reads `quiz.questions ?? []` and renders an
 * empty list. Every question disappears, of every type, and a refresh brings
 * them all back because that path reloads through GET.
 *
 * A coach reaches those handlers by renaming the quiz or toggling a setting -
 * both of which happen naturally on the way to activating one, which is why it
 * looked like activation was to blame.
 *
 * These tests drive the real handlers with a PATCH response shaped the way the
 * server actually shapes it: no `questions` key.
 */

const getQuiz = vi.fn();
const updateQuiz = vi.fn();

vi.mock('../../api/quizzes', () => ({
  getQuiz: (...args: unknown[]) => getQuiz(...args),
  updateQuiz: (...args: unknown[]) => updateQuiz(...args),
  listQuizzes: vi.fn().mockResolvedValue([]),
  createQuiz: vi.fn(),
  deleteQuiz: vi.fn(),
  duplicateQuiz: vi.fn(),
  exportAnswerKeyPdf: vi.fn(),
}));

vi.mock('../../api/questions', () => ({
  createQuestion: vi.fn(),
  updateQuestion: vi.fn(),
  deleteQuestion: vi.fn(),
  reorderQuestions: vi.fn(),
  retireQuestion: vi.fn(),
  restoreQuestion: vi.fn(),
  uploadQuestionClip: vi.fn(),
  deleteQuestionClip: vi.fn(),
  setClipDecisionPoint: vi.fn(),
}));

/** The complete quiz, as GET returns it. */
const fullQuiz = () =>
  ({
    id: 5,
    title: 'Cover 3 Test',
    description: '',
    one_question_at_a_time: false,
    require_all_answers: false,
    questions: [
      {
        id: 91,
        quiz_id: 5,
        question_text: 'What happens after the motion?',
        question_type: 'multiple_choice',
        position: 0,
        options: [],
        image: null,
        needs_image: false,
        clip: {
          id: 3,
          question_id: 91,
          content_type: 'video/mp4',
          duration_ms: 8000,
          has_poster: true,
          url: '/api/media/coach-token',
          poster_url: '/api/media/coach-poster',
        },
      },
    ],
  }) as unknown as Quiz;

/** What PATCH actually returns: the same quiz, with NO `questions` key. This
 *  is the shape that caused the bug, so it is the shape under test. */
const patchedQuiz = (over: Record<string, unknown> = {}) => {
  const { questions: _dropped, ...withoutQuestions } = fullQuiz() as unknown as Record<
    string,
    unknown
  >;
  return { ...withoutQuestions, ...over } as unknown as Quiz;
};

function renderEditor() {
  return render(
    <MemoryRouter initialEntries={['/quizzes/5']}>
      <Routes>
        <Route path="/quizzes/:quizId" element={<QuizEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  getQuiz.mockResolvedValue(fullQuiz());
  updateQuiz.mockReset();
});

describe('the builder keeps its questions when the quiz is patched', () => {
  it('shows the question to begin with', async () => {
    renderEditor();
    expect(await screen.findByText(/what happens after the motion/i)).toBeInTheDocument();
  });

  it('KEEPS the question after a setting is toggled', async () => {
    // THE REGRESSION. A coach toggling a setting on the way to activating the
    // quiz watched every question disappear.
    updateQuiz.mockResolvedValue(patchedQuiz({ one_question_at_a_time: true }));
    const user = userEvent.setup();
    renderEditor();
    await screen.findByText(/what happens after the motion/i);

    await user.click(screen.getByRole('checkbox', { name: /one question at a time/i }));

    await waitFor(() => expect(updateQuiz).toHaveBeenCalled());
    expect(screen.getByText(/what happens after the motion/i)).toBeInTheDocument();
  });

  it('still applies the change that was saved', async () => {
    // Preserving the questions must not mean ignoring the response.
    updateQuiz.mockResolvedValue(patchedQuiz({ title: 'Renamed Test' }));
    const user = userEvent.setup();
    renderEditor();
    await screen.findByText(/what happens after the motion/i);

    await user.click(screen.getByRole('checkbox', { name: /one question at a time/i }));

    await waitFor(() => expect(screen.getByDisplayValue('Renamed Test')).toBeInTheDocument());
    // ...and the question is still there alongside it.
    expect(screen.getByText(/what happens after the motion/i)).toBeInTheDocument();
  });

  it('keeps the clip attached to the question, not just the question row', async () => {
    // The reporter's question carried a recording; losing the clip would be
    // the same bug wearing a smaller coat.
    updateQuiz.mockResolvedValue(patchedQuiz({ one_question_at_a_time: true }));
    const user = userEvent.setup();
    const { container } = renderEditor();
    await screen.findByText(/what happens after the motion/i);

    await user.click(screen.getByRole('checkbox', { name: /one question at a time/i }));
    await waitFor(() => expect(updateQuiz).toHaveBeenCalled());

    const poster = container.querySelector('img[alt="Still frame from the recorded clip"]');
    expect(poster).toBeTruthy();
  });
});
