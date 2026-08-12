/**
 * The join flow: code, identity picker, and the identity-taken refusal.
 *
 * The picker is the one screen every player touches, so the rules it enforces
 * matter more than most: canonical names only, no ids on screen, and a taken
 * seat that is refused rather than quietly stolen.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import * as competitionApi from '../../api/competition';
import { CompetitionJoinPage } from './CompetitionJoinPage';
import { readSeat } from './competitionSeat';

vi.mock('../../api/competition', async () => {
  const actual = await vi.importActual<typeof competitionApi>('../../api/competition');
  return { ...actual, getLobby: vi.fn(), joinCompetition: vi.fn() };
});

const lobby = vi.mocked(competitionApi.getLobby);
const join = vi.mocked(competitionApi.joinCompetition);

function lobbyPayload(overrides: Partial<competitionApi.CompetitionLobby> = {}) {
  return {
    join_code: 'ABC123',
    status: 'LOBBY' as const,
    version: 1,
    quiz_title: 'Coverages',
    question_time_seconds: 20,
    server_now: '2026-08-12T13:00:00+00:00',
    roster: [
      { player_id: 12, display_name: 'Ada Lovelace', taken: false },
      { player_id: 13, display_name: 'Grace Hopper', taken: true },
    ],
    participants: [{ id: 3, display_name: 'Grace Hopper' }],
    ...overrides,
  };
}

function renderJoin(path = '/compete') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/compete" element={<CompetitionJoinPage />} />
        <Route path="/compete/:code/join" element={<CompetitionJoinPage />} />
        <Route path="/compete/:code" element={<div>waiting room</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  lobby.mockResolvedValue(lobbyPayload());
});

describe('code entry', () => {
  it('opens the picker for a valid code', async () => {
    const user = userEvent.setup();
    renderJoin();

    await user.type(screen.getByLabelText(/competition code/i), 'abc123');
    await user.click(screen.getByRole('button', { name: /enter/i }));

    expect(await screen.findByText(/who are you/i)).toBeInTheDocument();
    // Typed lowercase, sent uppercase - a code is read off a screen.
    expect(lobby).toHaveBeenCalledWith('ABC123');
  });

  it('explains an unknown code without jargon', async () => {
    const user = userEvent.setup();
    lobby.mockRejectedValue(new ApiError('nope', 404, undefined, 'invalid_code'));
    renderJoin();

    await user.type(screen.getByLabelText(/competition code/i), 'ZZZZZZ');
    await user.click(screen.getByRole('button', { name: /enter/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid/i);
  });

  it('explains a finished competition', async () => {
    const user = userEvent.setup();
    lobby.mockRejectedValue(new ApiError('gone', 410, undefined, 'session_ended'));
    renderJoin();

    await user.type(screen.getByLabelText(/competition code/i), 'ABC123');
    await user.click(screen.getByRole('button', { name: /enter/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/finished/i);
  });
});

describe('the identity picker', () => {
  it('offers only canonical roster names, with no free-text box', async () => {
    renderJoin('/compete/ABC123/join');

    expect(await screen.findByRole('button', { name: /Ada Lovelace/ })).toBeInTheDocument();
    // A typed name would create an identity the coach's results cannot be
    // attributed to.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows no database ids anywhere on screen', async () => {
    const { container } = renderJoin('/compete/ABC123/join');
    await screen.findByRole('button', { name: /Ada Lovelace/ });

    // The id travels in the request body because the server needs it; a player
    // should never see or type one.
    expect(container.textContent).not.toContain('12');
    expect(container.textContent).not.toContain('13');
  });

  it('disables an identity that is already taken', async () => {
    renderJoin('/compete/ABC123/join');

    const taken = await screen.findByRole('button', { name: /Grace Hopper/ });
    expect(taken).toBeDisabled();
  });

  it('stores the seat and moves to the waiting room on success', async () => {
    const user = userEvent.setup();
    join.mockResolvedValue({
      participant: {
        id: 3,
        player_id: 12,
        display_name: 'Ada Lovelace',
        joined_at: '2026-08-12T13:00:00+00:00',
        total_points: 0,
        current_streak: 0,
        best_streak: 0,
      },
      reconnect_token: 'opaque-token',
      join_code: 'ABC123',
      status: 'LOBBY',
      version: 2,
    });
    renderJoin('/compete/ABC123/join');

    await user.click(await screen.findByRole('button', { name: /Ada Lovelace/ }));

    await waitFor(() => expect(screen.getByText('waiting room')).toBeInTheDocument());
    expect(readSeat()).toEqual({
      joinCode: 'ABC123',
      token: 'opaque-token',
      displayName: 'Ada Lovelace',
    });
  });
});

describe('identity_taken', () => {
  it('refuses, explains the way out, and stays put', async () => {
    const user = userEvent.setup();
    join.mockRejectedValue(new ApiError('taken', 409, undefined, 'identity_taken'));
    renderJoin('/compete/ABC123/join');

    await user.click(await screen.findByRole('button', { name: /Ada Lovelace/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/already in this competition/i);
    expect(alert).toHaveTextContent(/ask your coach to remove/i);
    // Not navigated: the seat was NOT taken over.
    expect(screen.queryByText('waiting room')).not.toBeInTheDocument();
  });

  it('leaks nothing about the participant who holds the seat', async () => {
    const user = userEvent.setup();
    join.mockRejectedValue(new ApiError('taken', 409, undefined, 'identity_taken'));
    renderJoin('/compete/ABC123/join');

    await user.click(await screen.findByRole('button', { name: /Ada Lovelace/ }));
    await screen.findByRole('alert');

    // No token, and nothing stored - a refusal must not seat this device.
    expect(readSeat()).toBeNull();
    expect(JSON.stringify(sessionStorage)).not.toContain('token');
  });
});
