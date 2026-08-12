/**
 * The host lobby: coach reconnect, live arrivals, and removal.
 *
 * The reconnect test is the important one. A coach who refreshes the projector
 * screen must get the room back from the SERVER - if any of this came from
 * React state, a reload in front of a room would lose the join code.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import * as competitionApi from '../../api/competition';
import { HostLobbyPage } from './HostLobbyPage';

vi.mock('../../api/competition', async () => {
  const actual = await vi.importActual<typeof competitionApi>('../../api/competition');
  return {
    ...actual,
    getHostViewByCode: vi.fn(),
    getHostView: vi.fn(),
    getHostState: vi.fn(),
    removeParticipant: vi.fn(),
    endSession: vi.fn(),
  };
});

const byCode = vi.mocked(competitionApi.getHostViewByCode);
const hostView = vi.mocked(competitionApi.getHostView);
const hostState = vi.mocked(competitionApi.getHostState);
const remove = vi.mocked(competitionApi.removeParticipant);
const end = vi.mocked(competitionApi.endSession);

function participant(id: number, name: string) {
  return {
    id,
    player_id: id + 100,
    display_name: name,
    joined_at: '2026-08-12T13:00:00+00:00',
    total_points: 0,
    current_streak: 0,
    best_streak: 0,
  };
}

function view(overrides: Partial<competitionApi.CompetitionHostView> = {}) {
  return {
    id: 7,
    quiz_id: 3,
    quiz_title: 'Coverages',
    join_code: 'ABC123',
    status: 'LOBBY' as const,
    version: 1,
    current_round: 0,
    question_time_seconds: 20,
    participant_count: 1,
    created_at: '2026-08-12T13:00:00+00:00',
    started_at: null,
    ended_at: null,
    expires_at: '2026-08-12T19:00:00+00:00',
    participants: [participant(3, 'Ada Lovelace')],
    eligible_count: 3,
    not_joined: [{ player_id: 114, display_name: 'Alan Turing' }],
    ...overrides,
  };
}

function state(
  version = 1,
  status: competitionApi.CompetitionStatus = 'LOBBY',
  participantCount = 0,
) {
  return {
    version,
    status,
    server_now: '2026-08-12T13:00:00+00:00',
    current_round: 0,
    question_closes_at: null,
    participant_count: participantCount,
  };
}

function renderHost() {
  return render(
    <MemoryRouter initialEntries={['/compete/ABC123/host']}>
      <Routes>
        <Route path="/compete/:code/host" element={<HostLobbyPage />} />
        <Route path="/dashboard" element={<div>dashboard</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  byCode.mockResolvedValue(view());
  hostView.mockResolvedValue(view());
  hostState.mockResolvedValue(state());
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('coach reconnect', () => {
  it('rebuilds the whole room from the join code alone', async () => {
    renderHost();

    // Everything a refresh must restore: the code, the roster, the names.
    expect(await screen.findByText('ABC123')).toBeInTheDocument();
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(byCode).toHaveBeenCalledWith('ABC123');
  });

  it('shows the code from the URL before any request settles', () => {
    byCode.mockReturnValue(new Promise(() => {}));
    hostState.mockReturnValue(new Promise(() => {}));

    renderHost();

    // A projector must never show a blank where the join code goes.
    expect(screen.getByText('ABC123')).toBeInTheDocument();
  });

  it('refuses a competition belonging to another coach', async () => {
    byCode.mockRejectedValue(new ApiError('not found', 404));

    renderHost();

    expect(await screen.findByText(/not available to your account/i)).toBeInTheDocument();
  });
});

describe('the room filling up', () => {
  it('fetches the heavy view only when the version moves', async () => {
    hostState.mockResolvedValue(state(1));
    renderHost();
    await screen.findByText('Ada Lovelace');

    await waitFor(() => expect(hostState.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 4000,
    });

    // Polls many times; the roster fetch does not follow it.
    expect(hostView.mock.calls.length).toBeLessThan(hostState.mock.calls.length);
  });

  it('brings in a new arrival when the version changes', async () => {
    hostState.mockResolvedValueOnce(state(1)).mockResolvedValue(state(2));
    hostView.mockResolvedValue(
      view({ participants: [participant(3, 'Ada Lovelace'), participant(4, 'Grace Hopper')] }),
    );

    renderHost();

    // No manual refresh anywhere in this test.
    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
  });

  it('lists who has not arrived yet', async () => {
    renderHost();
    expect(await screen.findByText('Alan Turing')).toBeInTheDocument();
  });
});

describe('host controls', () => {
  it('confirms before removing, then drops the player', async () => {
    const user = userEvent.setup();
    remove.mockResolvedValue(view({ participants: [], participant_count: 0 }));
    renderHost();

    await user.click(await screen.findByRole('button', { name: /remove ada lovelace/i }));

    expect(window.confirm).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(7, 3);
    await waitFor(() => expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument());
  });

  it('does not remove anyone if the coach cancels', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderHost();

    await user.click(await screen.findByRole('button', { name: /remove ada lovelace/i }));

    expect(remove).not.toHaveBeenCalled();
  });

  it('does not pretend rounds exist yet', async () => {
    renderHost();

    const start = await screen.findByRole('button', { name: /start competition/i });
    // An enabled Start that goes nowhere would be a broken half-game.
    expect(start).toBeDisabled();
    expect(screen.getByText(/rounds arrive in the next release/i)).toBeInTheDocument();
  });

  it('shows the terminal state after ending', async () => {
    const user = userEvent.setup();
    end.mockResolvedValue(view({ status: 'ABANDONED', ended_at: '2026-08-12T13:30:00+00:00' }));
    renderHost();

    await user.click(await screen.findByRole('button', { name: /end lobby/i }));

    expect(await screen.findByRole('heading', { name: /competition ended/i })).toBeInTheDocument();
  });
});
