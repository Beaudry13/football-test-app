import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuizPreviewPage } from './QuizPreviewPage';
import * as quizzesApi from '../../api/quizzes';
import * as playApi from '../../api/play';
import type { Quiz } from '../../api/types';

const baseQuiz: Quiz = {
  id: 5,
  organization_id: 1,
  coach_id: 1,
  created_by_username: 'coach1',
  title: 'Week 1 Prep',
  description: null,
  one_question_at_a_time: false,
  folder_id: null,
  question_count: 2,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  questions: [
    {
      id: 10,
      quiz_id: 5,
      question_text: 'Is this cover 2?',
      question_type: 'true_false',
      position: 0,
      image: null,
      options: [
        { id: 100, question_id: 10, option_text: 'True', position: 0 },
        { id: 101, question_id: 10, option_text: 'False', position: 1 },
      ],
    },
    {
      id: 11,
      quiz_id: 5,
      question_text: 'Describe the coverage.',
      question_type: 'written',
      position: 1,
      image: null,
      options: [],
    },
  ],
};

function renderPreview() {
  render(
    <MemoryRouter initialEntries={['/quizzes/5/preview']}>
      <Routes>
        <Route path="/quizzes/:quizId/preview" element={<QuizPreviewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('QuizPreviewPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders every question at once when one_question_at_a_time is off, with the preview banner', async () => {
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue(baseQuiz);
    renderPreview();

    expect(await screen.findByText('Is this cover 2?', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Describe the coverage.', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Preview mode/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to editor/ })).toHaveAttribute(
      'href',
      '/quizzes/5',
    );
  });

  it('never calls the real play submission API', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue(baseQuiz);
    const submitSpy = vi.spyOn(playApi, 'submitQuiz');
    renderPreview();

    await screen.findByText('Is this cover 2?', { exact: false });
    await user.click(screen.getByRole('button', { name: 'Submit Peira' }));

    expect(await screen.findByText('End of preview')).toBeInTheDocument();
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it('walks one question at a time when the quiz is set to that mode', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue({ ...baseQuiz, one_question_at_a_time: true });
    renderPreview();

    expect(await screen.findByText('Question 1 of 2')).toBeInTheDocument();
    expect(screen.queryByText('Describe the coverage.', { exact: false })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Question 2 of 2')).toBeInTheDocument();
    expect(screen.getByText('Describe the coverage.', { exact: false })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Submit Peira' }));
    expect(await screen.findByText('End of preview')).toBeInTheDocument();
  });

  it('restarts the preview from the beginning', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue(baseQuiz);
    renderPreview();

    await screen.findByText('Is this cover 2?', { exact: false });
    await user.click(screen.getByRole('button', { name: 'Submit Peira' }));
    await screen.findByText('End of preview');

    await user.click(screen.getByRole('button', { name: 'Restart preview' }));
    expect(await screen.findByText('Is this cover 2?', { exact: false })).toBeInTheDocument();
  });

  it('shows an empty state instead of a broken preview when the quiz has no questions', async () => {
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue({ ...baseQuiz, questions: [] });
    renderPreview();

    expect(await screen.findByText(/No questions yet/)).toBeInTheDocument();
  });
});
