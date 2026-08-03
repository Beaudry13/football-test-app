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
