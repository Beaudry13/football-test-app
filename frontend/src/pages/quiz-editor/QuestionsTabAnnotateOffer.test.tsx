/** "Annotate now" - the step between photographing a play and drawing on it.
 *
 * A coach photographs something in order to mark it up. Before this, the route
 * from one to the other ran back through the question list, into a row's "..."
 * menu, and out again via Edit image - three taps and a hunt, on a phone, on a
 * field, for the thing the photo was taken to enable.
 *
 * The offer is made, never forced: the coach chose to add a question, not to
 * start drawing, and being thrown into a canvas they did not ask for is its
 * own kind of broken.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionsTab } from './QuestionsTab';
import type { Question, Quiz } from '../../api/types';

vi.mock('../../api/questions', () => ({
  createQuestion: vi.fn(),
  deleteQuestion: vi.fn(),
  reorderQuestions: vi.fn(),
  updateQuestion: vi.fn(),
  retireQuestion: vi.fn().mockResolvedValue({}),
  restoreQuestion: vi.fn().mockResolvedValue({}),
}));

import { createQuestion } from '../../api/questions';

const created = (over: Partial<Question> = {}): Question =>
  ({
    id: 77,
    quiz_id: 9,
    question_text: 'Who has the flat?',
    question_type: 'true_false',
    position: 0,
    options: [],
    image: '/uploads/play.jpg',
    ...over,
  }) as unknown as Question;

function renderTab() {
  const quiz = { id: 9, title: 'Install', questions: [] } as unknown as Quiz;
  return render(
    <MemoryRouter initialEntries={['/quizzes/9']}>
      <Routes>
        <Route
          path="/quizzes/9"
          element={<QuestionsTab quiz={quiz} reload={vi.fn().mockResolvedValue(undefined)} />}
        />
        <Route path="/quizzes/9/questions/:questionId/annotate" element={<div>ANNOTATION WORKSPACE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

/** Fills in the minimum a question needs and submits it. */
async function addQuestion(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '+ Add question' }));
  await user.type(screen.getByLabelText('Question'), 'Who has the flat?');
  await user.click(screen.getByRole('button', { name: 'Add question' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('after saving a question that has a photo', () => {
  it('offers to annotate it, without opening anything', async () => {
    vi.mocked(createQuestion).mockResolvedValue(created());
    const user = userEvent.setup();
    renderTab();

    await addQuestion(user);

    expect(await screen.findByRole('button', { name: 'Annotate now' })).toBeInTheDocument();
    // NOT thrown into the canvas - the coach asked to add a question.
    expect(screen.queryByText('ANNOTATION WORKSPACE')).not.toBeInTheDocument();
  });

  it('reaches the EXISTING annotation workspace in one tap', async () => {
    vi.mocked(createQuestion).mockResolvedValue(created({ id: 77 }));
    const user = userEvent.setup();
    renderTab();

    await addQuestion(user);
    await user.click(await screen.findByRole('button', { name: 'Annotate now' }));

    // The route already built, not a second drawing surface.
    expect(await screen.findByText('ANNOTATION WORKSPACE')).toBeInTheDocument();
  });

  it('lets the coach carry on instead', async () => {
    vi.mocked(createQuestion).mockResolvedValue(created());
    const user = userEvent.setup();
    renderTab();

    await addQuestion(user);
    await user.click(await screen.findByRole('button', { name: 'Not now' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Annotate now' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('ANNOTATION WORKSPACE')).not.toBeInTheDocument();
  });

  it('stands down when the coach starts the NEXT question', async () => {
    // The offer is about the question just saved. Left up over a fresh empty
    // form it would be pointing at something no longer on screen.
    vi.mocked(createQuestion).mockResolvedValue(created());
    const user = userEvent.setup();
    renderTab();

    await addQuestion(user);
    expect(await screen.findByRole('button', { name: 'Annotate now' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '+ Add question' }));

    expect(screen.queryByRole('button', { name: 'Annotate now' })).not.toBeInTheDocument();
  });
});

describe('after saving a question with NO photo', () => {
  it('says nothing at all', async () => {
    // There is nothing to draw on. An offer here would be a dead end.
    vi.mocked(createQuestion).mockResolvedValue(created({ image: null }));
    const user = userEvent.setup();
    renderTab();

    await addQuestion(user);

    await waitFor(() => expect(createQuestion).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Annotate now' })).not.toBeInTheDocument();
  });
});
