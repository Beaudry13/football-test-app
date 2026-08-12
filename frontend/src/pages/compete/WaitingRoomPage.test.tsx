/**
 * The player reconnect, and the promise that the 1 Hz poll stays cheap.
 *
 * These are the two behaviours a live room actually depends on: a refresh must
 * return the same seat, and thirty phones must not each be fetching a roster
 * every second.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import * as competitionApi from '../../api/competition';
import { WaitingRoomPage } from './WaitingRoomPage';
import { readSeat, writeSeat } from './competitionSeat';

vi.mock('../../api/competition', async () => {
  const actual = await vi.importActual<typeof competitionApi>('../../api/competition');
  return {
    ...actual,
    pollState: vi.fn(),
    getLobby: vi.fn(),
    resumeCompetition: vi.fn(),
  };
});

const poll = vi.mocked(competitionApi.pollState);
const lobby = vi.mocked(competitionApi.getLobby);
const resume = vi.mocked(competitionApi.resumeCompetition);

const TOKEN = 'opaque-token-value';

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

function participant() {
  return {
    id: 3,
    player_id: 12,
    display_name: 'Ada Lovelace',
    joined_at: '2026-08-12T13:00:00+00:00',
    total_points: 0,
    current_streak: 0,
    best_streak: 0,
  };
}

function renderRoom() {
  return render(
    <MemoryRouter initialEntries={['/compete/ABC123']}>
      <Routes>
        <Route path="/compete/:code" element={<WaitingRoomPage />} />
        <Route path="/compete/:code/join" element={<div>join screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  poll.mockResolvedValue(state());
  lobby.mockResolvedValue({
    join_code: 'ABC123',
    status: 'LOBBY',
    version: 1,
    quiz_title: 'Coverages',
    question_time_seconds: 20,
    server_now: '2026-08-12T13:00:00+00:00',
    roster: [],
    participants: [{ id: 3, display_name: 'Ada Lovelace' }],
  });
  resume.mockResolvedValue({
    participant: participant(),
    status: 'LOBBY',
    version: 1,
    server_now: '2026-08-12T13:00:00+00:00',
  });
});

describe('reconnect', () => {
  it('restores the seat from the stored token, not from memory', async () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });

    renderRoom();

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    // Identity comes from the server, addressed by the token alone.
    expect(resume).toHaveBeenCalledWith('ABC123', TOKEN);
  });

  it('shows the stored name immediately, before the server answers', async () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });
    resume.mockReturnValue(new Promise(() => {})); // never settles

    renderRoom();

    // A refresh should not blank the player's own name.
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('clears a rejected token and stops retrying', async () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });
    resume.mockRejectedValue(new ApiError('This session is no longer valid.', 401, undefined, 'invalid_token'));

    renderRoom();

    expect(await screen.findByText(/no longer in this competition/i)).toBeInTheDocument();
    // THE anti-loop assertion: a dead token must be dropped, not replayed.
    expect(readSeat()).toBeNull();

    const callsAfterFailure = resume.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(resume.mock.calls.length).toBe(callsAfterFailure);
  });

  it('offers a way back in after being removed', async () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });
    resume.mockRejectedValue(new ApiError('gone', 401, undefined, 'invalid_token'));

    renderRoom();

    expect(await screen.findByRole('button', { name: /join again/i })).toBeInTheDocument();
  });

  it('reports an ended competition honestly', async () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });
    poll.mockResolvedValue(state(2, 'COMPLETE'));

    renderRoom();

    expect(await screen.findByText(/competition ended/i)).toBeInTheDocument();
    expect(readSeat()).toBeNull();
  });

  it('reports an expired competition distinctly from a removal', async () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });
    resume.mockRejectedValue(new ApiError('expired', 410, undefined, 'session_expired'));

    renderRoom();

    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
  });

  it('sends a player with no seat to the join screen', async () => {
    renderRoom();
    await waitFor(() => expect(screen.getByText('join screen')).toBeInTheDocument());
    expect(resume).not.toHaveBeenCalled();
  });
});

describe('the polling contract', () => {
  it('never fetches the lobby at all', async () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });

    renderRoom();
    await screen.findByText('Ada Lovelace');
    await waitFor(() => expect(poll.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
    });

    // THE POINT OF participant_count. This screen needs a number, not a
    // roster, and fetching the roster was the largest single source of load
    // in the 30-player harness.
    expect(lobby).not.toHaveBeenCalled();
  });

  it('shows the player count straight from the cheap poll', async () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });
    poll.mockResolvedValue(state(1, 'LOBBY', 7));

    renderRoom();

    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(lobby).not.toHaveBeenCalled();
  });

  it('updates the count as the room fills, without a lobby fetch', async () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });
    poll.mockResolvedValueOnce(state(1, 'LOBBY', 2)).mockResolvedValue(state(2, 'LOBBY', 3));

    renderRoom();

    // 3s, not the 1s default: the second poll lands at ~1000ms exactly.
    expect(await screen.findByText('3', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(lobby).not.toHaveBeenCalled();
  });

  it('re-verifies the seat when the version moves', async () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });
    poll.mockResolvedValueOnce(state(1)).mockResolvedValue(state(2));

    renderRoom();

    // A removal bumps the version; this is how a removed player finds out.
    await waitFor(() => expect(resume.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
    });
  });

  it('survives a failed poll without losing the screen', async () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });
    poll.mockRejectedValueOnce(new Error('network blip')).mockResolvedValue(state());

    renderRoom();

    // One dropped request must not white-screen a competition.
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('stops polling a session that no longer exists', async () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });
    poll.mockRejectedValue(new ApiError('gone', 404, undefined, 'invalid_code'));

    renderRoom();

    await screen.findByRole('heading', { name: /unavailable|ended/i });
    const settled = poll.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // No retry storm against a dead code.
    expect(poll.mock.calls.length).toBe(settled);
  });
});
