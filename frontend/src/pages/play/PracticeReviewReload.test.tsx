import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayPage } from './PlayPage';
import * as playApi from '../../api/play';
import type { PracticeFeedback, ValidateCodeResponse } from '../../api/types';
import { rememberPlayer } from './playerSession';
import { clearPracticeReview, readPracticeReview, savePracticeReview } from './practiceReviewStore';

/**
 * A FINISHED PRACTICE SURVIVES A REFRESH IN ITS TAB: back to Practice complete
 * and Review missed - from the player's own picks kept in this tab only - not
 * a fresh run. No new API; nothing leaves the device.
 */

const joined = {
  mode: 'PRACTICE',
  access_code_id: 42,
  expires_at: '2026-12-02T00:00:00Z',
  roster_players: ['Jordan Smith'],
  roster_players_v2: [{ player_id: 501, name: 'Jordan Smith', jersey_number: '7', position: 'QB', photo_url: null }],
  quiz: {
    id: 5,
    title: 'Week 1 Prep',
    questions: [
      {
        id: 10,
        quiz_id: 5,
        question_text: 'Who gets the ball?',
        question_type: 'multiple_choice',
        position: 0,
        image: null,
        options: [
          { id: 100, question_id: 10, option_text: 'X', position: 0 },
          { id: 101, question_id: 10, option_text: 'Z', position: 1 },
        ],
      },
    ],
  },
} as unknown as ValidateCodeResponse;

const JORDAN = { playerId: 501, name: 'Jordan Smith', jerseyNumber: '7', position: 'QB' };
const missed: PracticeFeedback[] = [
  { question_id: 10, auto_gradable: true, is_correct: false, answer_explanation: 'The jet takes it.' } as PracticeFeedback,
];

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('a finished practice, after a refresh', () => {
  it('comes back to Practice complete and Review missed - not a new run', async () => {
    rememberPlayer('ABC123', JORDAN);
    savePracticeReview('ABC123', JORDAN, missed, [10], { 10: [101] });
    vi.spyOn(playApi, 'validateCode').mockResolvedValue(joined);
    const start = vi.spyOn(playApi, 'startAttempt');
    const claim = vi.spyOn(playApi, 'claimAttempt');
    render(
      <MemoryRouter initialEntries={['/play/ABC123']}>
        <Routes>
          <Route path="/play/:code" element={<PlayPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Practice complete' })).toBeInTheDocument();
    screen.getByRole('button', { name: 'Review missed' }).click();
    expect(await screen.findByText('You chose: Z')).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it("keeps only this player's run, and forgets it on Try again", () => {
    savePracticeReview('ABC123', JORDAN, missed, [10], { 10: [101] });
    expect(readPracticeReview('abc123', JORDAN)).not.toBeNull();
    expect(readPracticeReview('ABC123', { ...JORDAN, playerId: 502 })).toBeNull();
    clearPracticeReview('ABC123');
    expect(readPracticeReview('ABC123', JORDAN)).toBeNull();
  });
});
