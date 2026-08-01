import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultsCheckPage } from './ResultsCheckPage';
import * as playApi from '../../api/play';
import type { PlayerResultsResponse } from '../../api/types';

const playerResults: PlayerResultsResponse = {
  quiz_title: 'Week 1 Prep',
  player_name: 'Jordan Smith',
  submitted_at: '2026-01-01T00:05:00Z',
  answers: [
    {
      question_id: 10,
      question_text: 'Is this cover 2?',
      question_type: 'true_false',
      your_answer: 'False',
      correct_answer: 'True',
      is_correct: false,
      coach_feedback: null,
      graded_at: null,
    },
  ],
};

function renderAt(initialPath: string) {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/results" element={<ResultsCheckPage />} />
        <Route path="/results/:code/:playerName" element={<ResultsCheckPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ResultsCheckPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-fetches and renders results when code and name are in the URL', async () => {
    vi.spyOn(playApi, 'getPlayerResults').mockResolvedValue(playerResults);

    renderAt('/results/ABC123/Jordan%20Smith');

    await waitFor(() => expect(playApi.getPlayerResults).toHaveBeenCalledWith('ABC123', 'Jordan Smith'));
    expect(await screen.findByText('Results for Jordan Smith')).toBeInTheDocument();
    expect(screen.getByText('Incorrect')).toBeInTheDocument();
    expect(screen.getByText('Correct answer: True', { exact: false })).toBeInTheDocument();
  });

  it('shows a manual lookup form when no code/name are in the URL, and fetches on submit', async () => {
    const user = userEvent.setup();
    const resultsSpy = vi.spyOn(playApi, 'getPlayerResults').mockResolvedValue(playerResults);

    renderAt('/results');

    expect(screen.getByText('Check your results')).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText('CODE'), 'abc123');
    await user.type(screen.getByPlaceholderText('Your name'), 'Jordan Smith');
    await user.click(screen.getByRole('button', { name: 'View results' }));

    await waitFor(() => expect(resultsSpy).toHaveBeenCalledWith('ABC123', 'Jordan Smith'));
    expect(await screen.findByText('Results for Jordan Smith')).toBeInTheDocument();
  });

  it('shows a generic error and stays on the form when the lookup fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'getPlayerResults').mockRejectedValue(
      new Error('No results found for that code and name'),
    );

    renderAt('/results');

    await user.type(screen.getByPlaceholderText('CODE'), 'ZZZZZZ');
    await user.type(screen.getByPlaceholderText('Your name'), 'Nobody');
    await user.click(screen.getByRole('button', { name: 'View results' }));

    expect(await screen.findByText('No results found for that code and name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('CODE')).toBeInTheDocument();
  });
});
