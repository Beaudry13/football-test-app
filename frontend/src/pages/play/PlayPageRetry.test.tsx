import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayPage } from './PlayPage';
import * as playApi from '../../api/play';
import type { AttemptState, ValidateCodeResponse } from '../../api/types';
import { rememberPlayer } from './playerSession';
import { recordDone, reviewFrom } from './workProgress';

/**
 * TRY THE MISSES AGAIN, FROM PLAYER HOME. His stored review knows the run it
 * came from; "Try the misses again" asks the server for a new practice run of
 * just those misses - never a client-chosen list - and the run says what it is.
 */

const practice: ValidateCodeResponse = {
  mode: 'PRACTICE',
  access_code_id: 42,
  expires_at: '2026-08-02T00:00:00Z',
  roster_players: ['Jordan Smith'],
  roster_players_v2: [{ player_id: null, name: 'Jordan Smith', jersey_number: null, position: null, photo_url: null }],
  quiz: {
    id: 5,
    organization_id: 1,
    coach_id: 1,
    created_by_username: 'coach1',
    title: 'Install Reps',
    description: null,
    one_question_at_a_time: false,
    require_all_answers: false,
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
        question_text: 'Is the safety deep?',
        question_type: 'true_false',
        position: 1,
        image: null,
        options: [
          { id: 110, question_id: 11, option_text: 'True', position: 0 },
          { id: 111, question_id: 11, option_text: 'False', position: 1 },
        ],
      },
    ],
  },
};

const retryRun: AttemptState = {
  attempt_id: 901,
  status: 'in_progress',
  mode: 'PRACTICE',
  is_retry: true,
  question_order: [10],
  feedback: [],
  answers: [],
};

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(playApi, 'validateCode').mockResolvedValue(practice);
  vi.spyOn(playApi, 'getQuizTitleByCode').mockResolvedValue({ quiz_title: 'Install Reps' } as never);
});

describe('try the misses again, from Player Home', () => {
  it('asks the server for his misses of that run, and the run says it is his misses again', async () => {
    const user = userEvent.setup();
    rememberPlayer('PRAC01', { playerId: null, name: 'Jordan Smith', jerseyNumber: null, position: null });
    recordDone(
      'PRAC01',
      1,
      reviewFrom(
        [10, 11],
        [
          { question_id: 10, auto_gradable: true, is_correct: false, answer_explanation: 'Two high.' },
          { question_id: 11, auto_gradable: true, is_correct: true, answer_explanation: null },
        ],
        { 10: [101], 11: [110] },
        900,
      ),
    );
    const start = vi.spyOn(playApi, 'startAttempt').mockResolvedValue(retryRun);
    render(
      <MemoryRouter initialEntries={['/play/PRAC01?review=1']}>
        <Routes>
          <Route path="/play/:code" element={<PlayPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Missed 1 of 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try the misses again' }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ access_code_id: 42, retry_of_attempt_id: 900 })),
    );
    expect(await screen.findByText('Your misses, again')).toBeInTheDocument();
  });
});
