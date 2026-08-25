import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { QuizEditorPage } from './QuizEditorPage';
import * as quizzesApi from '../../api/quizzes';
import type { Quiz } from '../../api/types';

const quiz: Quiz = {
  id: 1,
  organization_id: 1,
  coach_id: 1,
  created_by_username: 'coach1',
  title: 'Week 1 Prep',
  description: null,
  one_question_at_a_time: false,
  require_all_answers: false,
  folder_id: null,
  question_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  questions: [],
};

function renderEditor() {
  return render(
    <MemoryRouter initialEntries={['/quizzes/1']}>
      <Routes>
        <Route path="/quizzes/:quizId" element={<QuizEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('QuizEditorPage settings', () => {
  it('toggles require_all_answers and persists it through updateQuiz', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue(quiz);
    const updateSpy = vi
      .spyOn(quizzesApi, 'updateQuiz')
      .mockResolvedValue({ ...quiz, require_all_answers: true });

    renderEditor();

    const toggle = await screen.findByLabelText('Require players to answer every question before submitting');
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith(1, { require_all_answers: true }));
    await waitFor(() => expect(toggle).toBeChecked());
  });

  it('shows the setting as already on for a quiz that has it enabled', async () => {
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue({ ...quiz, require_all_answers: true });

    renderEditor();

    const toggle = await screen.findByLabelText('Require players to answer every question before submitting');
    expect(toggle).toBeChecked();
  });
});


describe('the chrome above the tabs', () => {
  /** RESULTS IS READ, NOT EDITED.
   *
   * Measured at 375px: the title row, the description box and the two delivery
   * toggles put 552px of authoring furniture above "Teach next", which left the
   * action - the whole point of the panel - below the fold. None of it helps
   * read a result, and all of it stays one tap away on the tabs it belongs to.
   */
  function renderAt(tab: string) {
    return render(
      <MemoryRouter initialEntries={[`/quizzes/1?tab=${tab}`]}>
        <Routes>
          <Route path="/quizzes/:quizId" element={<QuizEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  const AUTHORING = [
    'Require players to answer every question before submitting',
    'Show players one question at a time',
  ];

  it('hides the authoring controls while reading Results', async () => {
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue(quiz);
    renderAt('results');

    // The title stays - it is the context for everything below it.
    expect(await screen.findByLabelText('Quiz title')).toBeInTheDocument();
    for (const label of AUTHORING) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Preview as player')).not.toBeInTheDocument();
    expect(screen.queryByText('Start Competition')).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText('Add a description (optional)'),
    ).not.toBeInTheDocument();
  });

  it('KEEPS EVERY CONTROL on the tabs that own them', async () => {
    // Hidden on one tab, not removed from the product.
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue(quiz);
    renderAt('questions');

    for (const label of AUTHORING) {
      expect(await screen.findByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Preview as player')).toBeInTheDocument();
    expect(screen.getByText('Start Competition')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Add a description (optional)')).toBeInTheDocument();
  });

  it('still reaches Results from the tab bar', async () => {
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue(quiz);
    renderAt('results');

    expect(await screen.findByRole('button', { name: 'Results' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Questions' })).toBeInTheDocument();
  });
});
