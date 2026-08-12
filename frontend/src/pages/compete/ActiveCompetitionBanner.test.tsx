/**
 * Coach recovery.
 *
 * The behaviour that matters is negative as much as positive: this must show
 * a live room, and must show nothing at all otherwise - a banner that lingers
 * after a competition ends would send a coach into a dead room.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as competitionApi from '../../api/competition';
import { ActiveCompetitionBanner } from './ActiveCompetitionBanner';

vi.mock('../../api/competition', async () => {
  const actual = await vi.importActual<typeof competitionApi>('../../api/competition');
  return { ...actual, getActiveCompetitions: vi.fn() };
});

const getActive = vi.mocked(competitionApi.getActiveCompetitions);

function session(overrides: Partial<competitionApi.ActiveCompetition> = {}) {
  return {
    id: 7,
    join_code: 'ABC123',
    quiz_id: 3,
    quiz_title: 'Coverage Recognition',
    status: 'LOBBY' as const,
    participant_count: 18,
    created_at: '2026-08-12T13:00:00+00:00',
    expires_at: '2026-08-12T19:00:00+00:00',
    ...overrides,
  };
}

function renderBanner(quizId?: number) {
  return render(
    <MemoryRouter>
      <ActiveCompetitionBanner quizId={quizId} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.clearAllMocks();
  getActive.mockResolvedValue([session()]);
});

describe('recovering a live competition', () => {
  it('names the quiz, the count, and the way back', async () => {
    renderBanner();

    expect(await screen.findByText(/competition in progress/i)).toBeInTheDocument();
    expect(screen.getByText(/Coverage Recognition · 18 players joined/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /return to competition/i })).toHaveAttribute(
      'href',
      '/compete/ABC123/host',
    );
  });

  it('reads nothing from browser storage', async () => {
    renderBanner();
    await screen.findByText(/competition in progress/i);

    // THE POINT: a brand-new browser must recover just as well as a refreshed
    // tab, so the server is the only source consulted.
    expect(getActive).toHaveBeenCalledTimes(1);
    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });

  it('renders nothing when no competition is live', async () => {
    getActive.mockResolvedValue([]);
    const { container } = renderBanner();

    await waitFor(() => expect(getActive).toHaveBeenCalled());
    // An ended or expired session is excluded server-side; the banner must not
    // invent a way back into a dead room.
    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing when the lookup fails', async () => {
    getActive.mockRejectedValue(new Error('offline'));
    const { container } = renderBanner();

    await waitFor(() => expect(getActive).toHaveBeenCalled());
    // Recovery is an affordance, not a prerequisite - it must never break the
    // dashboard it sits on.
    expect(container).toBeEmptyDOMElement();
  });

  it('uses singular wording for one player', async () => {
    getActive.mockResolvedValue([session({ participant_count: 1 })]);
    renderBanner();

    expect(await screen.findByText(/1 player joined/)).toBeInTheDocument();
  });

  it('filters to the quiz it is shown on', async () => {
    getActive.mockResolvedValue([
      session({ id: 7, quiz_id: 3, join_code: 'AAA111' }),
      session({ id: 8, quiz_id: 9, join_code: 'BBB222', quiz_title: 'Other Quiz' }),
    ]);

    renderBanner(9);

    expect(await screen.findByText(/Other Quiz/)).toBeInTheDocument();
    expect(screen.queryByText(/Coverage Recognition/)).not.toBeInTheDocument();
  });

  it('shows every live room when not scoped to a quiz', async () => {
    getActive.mockResolvedValue([
      session({ id: 7, join_code: 'AAA111' }),
      session({ id: 8, join_code: 'BBB222', quiz_title: 'Other Quiz' }),
    ]);

    renderBanner();

    expect(await screen.findAllByText(/competition in progress/i)).toHaveLength(2);
  });

  it('exposes no participant identities', async () => {
    const { container } = renderBanner();
    await screen.findByText(/competition in progress/i);

    // A count is fine; names are not. The endpoint returns none, and the
    // banner must not start asking for any.
    expect(container.textContent).not.toMatch(/display_name|player_id|token/);
  });
});
