/** Results, with two players called John Smith.
 *
 * Attempt mode: jersey only. And the label is only ever the LINK TEXT - where
 * each link goes is still decided by `player_id`, exactly as before.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultsTab } from './ResultsTab';
import * as gradingApi from '../../api/grading';
import * as authContext from '../../auth/AuthContext';
import type { Coach, PlayerResponse, Quiz, QuizDashboard } from '../../api/types';

function mockAuth() {
  const coach: Coach = {
    id: 1,
    username: 'coach1',
    email: 'coach1@example.com',
    organization: 'Wildcats',
    organization_id: 1,
    role: 'member',
    is_platform_owner: false,
    created_at: '2026-01-01T00:00:00Z',
  };
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    coach,
    isLoading: false,
    login: vi.fn(),
    registerWithInvite: vi.fn(),
    registerWithBetaInvite: vi.fn(),
    logout: vi.fn(),
  });
}

const quiz: Quiz = {
  id: 1,
  organization_id: 1,
  coach_id: 1,
  created_by_username: 'coach1',
  title: 'Week 1 Prep',
  description: null,
  one_question_at_a_time: true,
  require_all_answers: false,
  folder_id: null,
  question_count: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const dashboard: QuizDashboard = {
  quiz_id: 1,
  roster_size: 3,
  response_count: 3,
  response_rate: 1,
  missing_players: [],
  question_breakdown: [],
  concept_breakdown: [],
  verification: null,
};

const response = (over: Partial<PlayerResponse>): PlayerResponse => ({
  id: 1,
  quiz_id: 1,
  access_code_id: 9,
  player_name: 'John Smith',
  display_name: 'John Smith',
  submitted_at: '2026-01-01T00:05:00Z',
  answers: [],
  ...over,
});

function renderWith(responses: PlayerResponse[]) {
  vi.spyOn(gradingApi, 'getQuizDashboard').mockResolvedValue(dashboard);
  vi.spyOn(gradingApi, 'listResponses').mockResolvedValue(responses);
  render(
    <MemoryRouter>
      <ResultsTab quiz={quiz} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  mockAuth();
});

describe('Results with same-named players', () => {
  it('labels them by jersey, with no position, and links each by player_id', async () => {
    renderWith([
      response({ id: 1, player_id: 21, jersey_number: '12' }),
      response({ id: 2, player_id: 22, jersey_number: '37' }),
      response({ id: 3, player_id: null, player_name: 'Mike Beaudry', display_name: 'Mike Beaudry' }),
    ]);

    const qb = await screen.findByRole('link', { name: 'John Smith · #12' });
    const lb = screen.getByRole('link', { name: 'John Smith · #37' });
    expect(qb).toHaveAttribute('href', '/roster/21');
    expect(lb).toHaveAttribute('href', '/roster/22');
  });

  it('a unique legacy name is untouched and keeps its legacy link', async () => {
    renderWith([
      response({ id: 1, player_id: 21, jersey_number: '12' }),
      response({ id: 2, player_id: 22, jersey_number: '37' }),
      response({ id: 3, player_id: null, player_name: 'Mike Beaudry', display_name: 'Mike Beaudry' }),
    ]);

    const mike = await screen.findByRole('link', { name: 'Mike Beaudry' });
    expect(mike).toHaveAttribute('href', '/players/Mike%20Beaudry/history');
  });

  it('one player with two attempts is not ambiguous with themselves', async () => {
    renderWith([
      response({ id: 1, player_id: 21, jersey_number: '12' }),
      response({ id: 2, player_id: 21, jersey_number: '12', access_code_id: 10 }),
    ]);

    const links = await screen.findAllByRole('link', { name: 'John Smith' });
    expect(links).toHaveLength(2);
    links.forEach((link) => expect(link).toHaveAttribute('href', '/roster/21'));
  });
});
