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
    transition: vi.fn(),
    removeParticipant: vi.fn(),
    endSession: vi.fn(),
  };
});

const byCode = vi.mocked(competitionApi.getHostViewByCode);
const hostView = vi.mocked(competitionApi.getHostView);
const hostState = vi.mocked(competitionApi.getHostState);
const remove = vi.mocked(competitionApi.removeParticipant);
const end = vi.mocked(competitionApi.endSession);
const transition = vi.mocked(competitionApi.transition);

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
    total_rounds: 0,
    question_opened_at: null,
    question_closes_at: null,
    participant_count: participantCount,
    answered_count: 0,
    all_in: false,
    answering_open: false,
    podium_step: 0,
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
  transition.mockResolvedValue(view());
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

  it('starts the competition once somebody has joined', async () => {
    const user = userEvent.setup();
    renderHost();

    const start = await screen.findByRole('button', { name: /start competition/i });
    expect(start).toBeEnabled();
    await user.click(start);

    // The version guard travels with it - that is what makes two host tabs safe.
    await waitFor(() =>
      expect(transition).toHaveBeenCalledWith(7, 'START_QUESTION', expect.any(Number)),
    );
  });

  it('will not start an empty room', async () => {
    byCode.mockResolvedValue(view({ participants: [], participant_count: 0 }));
    hostView.mockResolvedValue(view({ participants: [], participant_count: 0 }));
    renderHost();

    const start = await screen.findByRole('button', { name: /start competition/i });
    // Starting with nobody in would burn the first question on an empty room.
    expect(start).toBeDisabled();
  });

  it('shows the terminal state after ending', async () => {
    const user = userEvent.setup();
    end.mockResolvedValue(view({ status: 'ABANDONED', ended_at: '2026-08-12T13:30:00+00:00' }));
    renderHost();

    await user.click(await screen.findByRole('button', { name: /end lobby/i }));

    expect(await screen.findByRole('heading', { name: /competition ended/i })).toBeInTheDocument();
  });
});

describe('scan to join', () => {
  it('offers a QR pointing at this competition, on the lobby', async () => {
    renderHost();

    const qr = await screen.findByRole('img', { name: /scan to join competition ABC123/i });
    expect(qr).toBeInTheDocument();
    // The code stays the hero and the typed route stays available - the QR is
    // a shortcut, never the only way in.
    expect(screen.getByText('ABC123')).toBeInTheDocument();
    expect(screen.getByText(/scan or enter the code/i)).toBeInTheDocument();
  });

  it('follows the competition, not a hard-coded room', async () => {
    byCode.mockResolvedValue(view({ join_code: 'ZLMU88' }));
    hostView.mockResolvedValue(view({ join_code: 'ZLMU88' }));
    renderHost();

    expect(
      await screen.findByRole('img', { name: /scan to join competition ZLMU88/i }),
    ).toBeInTheDocument();
  });

  it('is gone once the room is playing', async () => {
    // There is nobody left to let in mid-question, and the projector needs the
    // whole screen for the question.
    byCode.mockResolvedValue(view({ status: 'QUESTION_OPEN' }));
    hostView.mockResolvedValue(view({ status: 'QUESTION_OPEN' }));
    hostState.mockResolvedValue(state(2, 'QUESTION_OPEN'));
    renderHost();

    await waitFor(() => expect(hostState).toHaveBeenCalled());
    expect(screen.queryByRole('img', { name: /scan to join/i })).not.toBeInTheDocument();
  });

  it('is gone once the competition has ended', async () => {
    byCode.mockResolvedValue(view({ status: 'ABANDONED' }));
    hostView.mockResolvedValue(view({ status: 'ABANDONED' }));
    renderHost();

    await screen.findByRole('heading', { name: /competition ended/i });
    expect(screen.queryByRole('img', { name: /scan to join/i })).not.toBeInTheDocument();
  });
});

describe('finishing early', () => {
  /** A revealed round with more questions still to play. */
  function midRunReveal(roundNumber = 3, totalRounds = 13) {
    return view({
      status: 'QUESTION_REVEAL',
      current_round: roundNumber - 1,
      available_actions: ['FINISH', 'NEXT_QUESTION', 'SHOW_LEADERBOARD'],
      round: {
        round_index: roundNumber - 1,
        round_number: roundNumber,
        total_rounds: totalRounds,
        question: {
          id: 9,
          question_text: 'Which coverage?',
          question_type: 'multiple_choice',
          image: null,
          options: [{ id: 1, option_text: 'Cover 2', position: 0 }],
        },
        answered_count: 1,
        participant_count: 1,
        all_in: false,
        answering_open: false,
        question_opened_at: '2026-08-12T13:00:00+00:00',
        question_closes_at: '2026-08-12T13:00:20+00:00',
        distribution: null,
      },
    } as Partial<competitionApi.CompetitionHostView>);
  }

  it('REGRESSION: offers Finish before the last question', async () => {
    // This button used to carry `&& !actions.includes('NEXT_QUESTION')`, so it
    // appeared only once the quiz ran out of questions. A coach playing five
    // questions from a bank of thirty then had NO way to reach the podium -
    // the only early exit was End competition, which abandons the room and
    // replaces every player's result with "your coach has ended this".
    byCode.mockResolvedValue(midRunReveal());
    hostView.mockResolvedValue(midRunReveal());
    hostState.mockResolvedValue(state(2, 'QUESTION_REVEAL'));
    renderHost();

    expect(
      await screen.findByRole('button', { name: /finish competition/i }),
    ).toBeInTheDocument();
    // And it sits alongside the ordinary continue control, not instead of it.
    expect(screen.getByRole('button', { name: /next question/i })).toBeInTheDocument();
  });

  it('warns before throwing away the questions that remain', async () => {
    const user = userEvent.setup();
    byCode.mockResolvedValue(midRunReveal(3, 13));
    hostView.mockResolvedValue(midRunReveal(3, 13));
    hostState.mockResolvedValue(state(2, 'QUESTION_REVEAL'));
    renderHost();

    await user.click(await screen.findByRole('button', { name: /finish competition/i }));

    // FINISH is a one-way door - there is no row back into QUESTION_OPEN from
    // PODIUM - and this button now sits next to Next question.
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('10 questions'));
    await waitFor(() =>
      expect(transition).toHaveBeenCalledWith(7, 'FINISH', expect.any(Number)),
    );
  });

  it('does not finish if the coach cancels the warning', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    byCode.mockResolvedValue(midRunReveal());
    hostView.mockResolvedValue(midRunReveal());
    hostState.mockResolvedValue(state(2, 'QUESTION_REVEAL'));
    renderHost();

    await user.click(await screen.findByRole('button', { name: /finish competition/i }));

    expect(transition).not.toHaveBeenCalled();
  });

  it('does not nag on the last question, where nothing is lost', async () => {
    const user = userEvent.setup();
    // The server drops NEXT_QUESTION once no playable round remains.
    const last = view({
      ...midRunReveal(13, 13),
      available_actions: ['FINISH', 'SHOW_LEADERBOARD'],
    } as Partial<competitionApi.CompetitionHostView>);
    byCode.mockResolvedValue(last);
    hostView.mockResolvedValue(last);
    hostState.mockResolvedValue(state(2, 'QUESTION_REVEAL'));
    renderHost();

    await user.click(await screen.findByRole('button', { name: /finish competition/i }));

    expect(window.confirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(transition).toHaveBeenCalledWith(7, 'FINISH', expect.any(Number)),
    );
  });
});
