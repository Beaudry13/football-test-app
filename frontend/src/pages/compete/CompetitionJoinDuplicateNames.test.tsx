/**
 * Two players called John Smith, one Competition picker.
 *
 * Before this, they were two identical buttons - and picking the wrong one took
 * the other player's seat, after which `taken` locked the right one out with no
 * way to tell which was which. The label is only something to READ: the tests
 * below that matter most are the ones proving each button still sends its own
 * player_id, and that `taken` is still decided per person.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as competitionApi from '../../api/competition';
import { CompetitionJoinPage } from './CompetitionJoinPage';

vi.mock('../../api/competition', async () => {
  const actual = await vi.importActual<typeof competitionApi>('../../api/competition');
  return { ...actual, getLobby: vi.fn(), joinCompetition: vi.fn() };
});

const lobby = vi.mocked(competitionApi.getLobby);
const join = vi.mocked(competitionApi.joinCompetition);

const QB_ID = 21;
const LB_ID = 22;

function lobbyPayload(roster: competitionApi.RosterEntry[]): competitionApi.CompetitionLobby {
  return {
    join_code: 'ABC123',
    status: 'LOBBY',
    version: 1,
    quiz_title: 'Coverages',
    question_time_seconds: 20,
    server_now: '2026-08-12T13:00:00+00:00',
    roster,
    participants: [],
  };
}

const SMITHS: competitionApi.RosterEntry[] = [
  { player_id: QB_ID, display_name: 'John Smith', jersey_number: '12', position: 'QB', taken: false },
  { player_id: LB_ID, display_name: 'John Smith', jersey_number: '37', position: 'LB', taken: false },
  { player_id: 23, display_name: 'Mike Beaudry', jersey_number: '4', position: 'QB', taken: false },
];

function renderJoin() {
  return render(
    <MemoryRouter initialEntries={['/compete/ABC123/join']}>
      <Routes>
        <Route path="/compete/:code/join" element={<CompetitionJoinPage />} />
        <Route path="/compete/:code" element={<div>waiting room</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

function joinResult(playerId: number) {
  return {
    participant: {
      id: 3,
      player_id: playerId,
      display_name: 'John Smith',
      joined_at: '2026-08-12T13:00:00+00:00',
      total_points: 0,
      current_streak: 0,
      best_streak: 0,
    },
    reconnect_token: 'opaque-token',
    join_code: 'ABC123',
    status: 'LOBBY' as const,
    version: 2,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  lobby.mockResolvedValue(lobbyPayload(SMITHS));
});

describe('two same-named players', () => {
  it('are visually distinguishable', async () => {
    renderJoin();

    const qb = await screen.findByRole('button', { name: /John Smith.*#12 QB/ });
    const lb = screen.getByRole('button', { name: /John Smith.*#37 LB/ });
    expect(qb).not.toBe(lb);
    expect(screen.getByText('#12 QB')).toBeInTheDocument();
    expect(screen.getByText('#37 LB')).toBeInTheDocument();
  });

  it('a unique name carries no tag, even with metadata available', async () => {
    renderJoin();

    const mike = await screen.findByRole('button', { name: /Mike Beaudry/ });
    expect(mike).toHaveTextContent(/^Mike Beaudry$/);
  });

  it('the first choice sends the first player_id', async () => {
    const user = userEvent.setup();
    join.mockResolvedValue(joinResult(QB_ID));
    renderJoin();

    await user.click(await screen.findByRole('button', { name: /#12 QB/ }));

    await waitFor(() => expect(join).toHaveBeenCalledWith('ABC123', QB_ID));
  });

  it('the second choice sends the second player_id', async () => {
    const user = userEvent.setup();
    join.mockResolvedValue(joinResult(LB_ID));
    renderJoin();

    await user.click(await screen.findByRole('button', { name: /#37 LB/ }));

    await waitFor(() => expect(join).toHaveBeenCalledWith('ABC123', LB_ID));
    expect(join).not.toHaveBeenCalledWith('ABC123', QB_ID);
  });

  it('taken is per person: one Smith in, the other still free', async () => {
    lobby.mockResolvedValue(
      lobbyPayload([{ ...SMITHS[0] }, { ...SMITHS[1], taken: true }, SMITHS[2]]),
    );
    renderJoin();

    expect(await screen.findByRole('button', { name: /#37 LB/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /#12 QB/ })).toBeEnabled();
  });

  it('still shows no database ids anywhere on screen', async () => {
    const { container } = renderJoin();
    await screen.findByRole('button', { name: /#12 QB/ });

    expect(container.textContent).not.toContain(String(QB_ID));
    expect(container.textContent).not.toContain(String(LB_ID));
  });

  it('two same-named players with no metadata fall back to the bare name', async () => {
    lobby.mockResolvedValue(
      lobbyPayload([
        { player_id: QB_ID, display_name: 'John Smith', jersey_number: null, position: null, taken: false },
        { player_id: LB_ID, display_name: 'John Smith', jersey_number: null, position: null, taken: false },
      ]),
    );
    renderJoin();

    const buttons = await screen.findAllByRole('button', { name: /John Smith/ });
    expect(buttons).toHaveLength(2);
    buttons.forEach((button) => expect(button).toHaveTextContent(/^John Smith$/));
  });
});
