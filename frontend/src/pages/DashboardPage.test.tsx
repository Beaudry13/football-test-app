import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';
import * as quizzesApi from '../api/quizzes';
import type { Quiz } from '../api/types';

const sampleQuiz: Quiz = {
  id: 1,
  coach_id: 1,
  title: 'Week 1 Prep',
  description: null,
  one_question_at_a_time: true,
  question_count: 3,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
};

function renderDashboard() {
  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>,
  );
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the empty state when there are no quizzes', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    renderDashboard();

    expect(await screen.findByText('No quizzes yet. Create your first one above.')).toBeInTheDocument();
  });

  it('lists quizzes with their question count and update date', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    renderDashboard();

    expect(await screen.findByText('Week 1 Prep')).toBeInTheDocument();
    expect(screen.getByText(/3 questions/)).toBeInTheDocument();
  });

  it('shows the server error when the quiz list fails to load', async () => {
    vi.spyOn(quizzesApi, 'listQuizzes').mockRejectedValue(new Error('Could not reach the server.'));
    renderDashboard();

    expect(await screen.findByText('Could not reach the server.')).toBeInTheDocument();
  });

  it('disables New quiz until a title is entered, then creates and refreshes the list', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    const createSpy = vi.spyOn(quizzesApi, 'createQuiz').mockResolvedValue(sampleQuiz);
    renderDashboard();
    await screen.findByText('No quizzes yet. Create your first one above.');

    const newQuizButton = screen.getByRole('button', { name: 'New quiz' });
    expect(newQuizButton).toBeDisabled();

    await user.type(screen.getByPlaceholderText('New quiz title, e.g. Week 3 Prep'), '  Week 3 Prep  ');
    expect(newQuizButton).not.toBeDisabled();

    vi.mocked(quizzesApi.listQuizzes).mockResolvedValue([sampleQuiz]);
    await user.click(newQuizButton);

    await waitFor(() => expect(createSpy).toHaveBeenCalledWith({ title: 'Week 3 Prep' }));
    expect(quizzesApi.listQuizzes).toHaveBeenCalledTimes(2); // initial load + refresh after create
  });

  it('duplicates a quiz and refreshes the list', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    const duplicateSpy = vi.spyOn(quizzesApi, 'duplicateQuiz').mockResolvedValue(sampleQuiz);
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(duplicateSpy).toHaveBeenCalledWith(1));
  });

  it('asks for confirmation before deleting, and does nothing if declined', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    const deleteSpy = vi.spyOn(quizzesApi, 'deleteQuiz').mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(window.confirm).toHaveBeenCalled();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('deletes the quiz once the confirmation is accepted', async () => {
    const user = userEvent.setup();
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([sampleQuiz]);
    const deleteSpy = vi.spyOn(quizzesApi, 'deleteQuiz').mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDashboard();
    await screen.findByText('Week 1 Prep');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledWith(1));
  });
});
