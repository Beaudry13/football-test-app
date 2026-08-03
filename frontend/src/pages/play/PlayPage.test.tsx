import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayPage } from './PlayPage';
import * as playApi from '../../api/play';
import type { AttemptState, PlayerResultsResponse, ValidateCodeResponse } from '../../api/types';

const joinedResponse: ValidateCodeResponse = {
  access_code_id: 42,
  expires_at: '2026-08-02T00:00:00Z',
  roster_players: ['Jordan Smith', 'Alex Lee'],
  quiz: {
    id: 5,
    organization_id: 1,
    coach_id: 1,
    created_by_username: 'coach1',
    title: 'Week 1 Prep',
    description: null,
    one_question_at_a_time: false,
    folder_id: null,
    question_count: 1,
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
    ],
  },
};

const startedAttempt: AttemptState = { attempt_id: 900, status: 'in_progress', answers: [] };

const submittedResponse = {
  id: 1,
  quiz_id: 5,
  access_code_id: 42,
  player_name: 'Jordan Smith',
  submitted_at: '2026-01-01T00:05:00Z',
  answers: [],
};

const playerResults: PlayerResultsResponse = {
  quiz_title: 'Week 1 Prep',
  player_name: 'Jordan Smith',
  submitted_at: '2026-01-01T00:05:00Z',
  answers: [
    {
      question_id: 10,
      question_text: 'Is this cover 2?',
      question_type: 'true_false',
      your_answer: 'True',
      correct_answer: 'True',
      is_correct: true,
      coach_feedback: null,
      graded_at: null,
    },
  ],
};

function renderPlayPage(initialPath = '/play') {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/play" element={<PlayPage />} />
        <Route path="/play/:code" element={<PlayPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PlayPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('pre-fills the code from the URL when a player follows a direct link', () => {
    renderPlayPage('/play/ABC123');

    expect(screen.getByPlaceholderText('CODE')).toHaveValue('ABC123');
  });

  it('walks a player from code entry through to a submitted confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'validateCode').mockResolvedValue(joinedResponse);
    const startSpy = vi.spyOn(playApi, 'startAttempt').mockResolvedValue(startedAttempt);
    vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);
    const submitSpy = vi.spyOn(playApi, 'submitQuiz').mockResolvedValue(submittedResponse);
    const resultsSpy = vi.spyOn(playApi, 'getPlayerResults').mockResolvedValue(playerResults);
    renderPlayPage();

    await user.type(screen.getByPlaceholderText('CODE'), 'abc123');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Week 1 Prep')).toBeInTheDocument();
    expect(playApi.validateCode).toHaveBeenCalledWith('ABC123'); // the input uppercases as you type

    await user.click(screen.getByRole('button', { name: 'Jordan Smith' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(startSpy).toHaveBeenCalledWith({ access_code_id: 42, player_name: 'Jordan Smith' }),
    );
    expect(
      await screen.findByText((_, element) => element?.textContent === '1. Is this cover 2?'),
    ).toBeInTheDocument();
    await user.click(screen.getByLabelText('True'));
    await user.click(screen.getByRole('button', { name: 'Submit Peira' }));

    await waitFor(() =>
      expect(submitSpy).toHaveBeenCalledWith({
        access_code_id: 42,
        player_name: 'Jordan Smith',
        answers: [{ question_id: 10, selected_option_id: 100, answer_text: null }],
      }),
    );
    await waitFor(() => expect(resultsSpy).toHaveBeenCalledWith('ABC123', 'Jordan Smith'));
    expect(await screen.findByText('Results for Jordan Smith')).toBeInTheDocument();
    expect(screen.getByText('Is this cover 2?')).toBeInTheDocument();
    expect(screen.getByText('Correct')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'this link' })).toHaveAttribute(
      'href',
      '/results/ABC123/Jordan%20Smith',
    );
  });

  it('shows the server error and lets the player retry when the code is invalid', async () => {
    const user = userEvent.setup();
    vi.spyOn(playApi, 'validateCode').mockRejectedValue(new Error('Invalid or expired access code'));
    renderPlayPage();

    await user.type(screen.getByPlaceholderText('CODE'), 'BADCOD');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Invalid or expired access code')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('CODE')).toBeInTheDocument();
  });
});
