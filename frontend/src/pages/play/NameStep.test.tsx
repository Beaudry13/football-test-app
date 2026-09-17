import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NameStep } from './NameStep';
import { ApiError } from '../../api/client';
import type { RosterPlayerOption } from '../../api/types';

const rosterPlayers: RosterPlayerOption[] = [
  { player_id: 501, name: 'Jordan Smith', jersey_number: '7', position: 'QB', photo_url: null },
  { player_id: null, name: 'Alex Lee', jersey_number: null, position: null, photo_url: null },
];

const rosterPlayersWithPhotos: RosterPlayerOption[] = [
  { player_id: 501, name: 'Jordan Smith', jersey_number: '7', position: 'QB', photo_url: '/uploads/jordan.jpg' },
  { player_id: 502, name: 'Chris Smith', jersey_number: '9', position: 'WR', photo_url: null },
];

/** "Choose your name". What happens after a choice - quiz, PIN or results - is
 *  PlayPage's decision; this screen reports who was chosen, and HOW: a roster
 *  tap is never `continuing`, so it can never use a stored token. */
describe('NameStep', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the chosen canonical player, not continuing', async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn().mockResolvedValue(undefined);
    render(<NameStep quizTitle="Week 1 Prep" rosterPlayers={rosterPlayers} onChoose={onChoose} />);

    expect(screen.getByText('Choose your name.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Jordan Smith (#7 · QB)' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(onChoose).toHaveBeenCalledWith(
        { playerId: 501, name: 'Jordan Smith', jerseyNumber: '7', position: 'QB' },
        false,
      ),
    );
  });

  it('reports a legacy (free-text) roster entry with no player id', async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn().mockResolvedValue(undefined);
    render(<NameStep quizTitle="Week 1 Prep" rosterPlayers={rosterPlayers} onChoose={onChoose} />);

    await user.click(screen.getByRole('button', { name: 'Alex Lee' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() =>
      expect(onChoose).toHaveBeenCalledWith(
        { playerId: null, name: 'Alex Lee', jerseyNumber: null, position: null },
        false,
      ),
    );
  });

  it('shows an inline error and stays on this step when the choice fails', async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn().mockRejectedValue(new ApiError('Invalid or expired access code', 404));
    render(<NameStep quizTitle="Week 1 Prep" rosterPlayers={rosterPlayers} onChoose={onChoose} />);

    await user.click(screen.getByRole('button', { name: 'Jordan Smith (#7 · QB)' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Invalid or expired access code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('offers the remembered player as one tap, continuing, instead of the roster', async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn().mockResolvedValue(undefined);
    const remembered = { playerId: 501, name: 'Jordan Smith', jerseyNumber: '7', position: 'QB' };
    render(
      <NameStep quizTitle="Week 1 Prep" rosterPlayers={rosterPlayers} remembered={remembered} onChoose={onChoose} />,
    );

    // The roster is not on screen, so a teammate cannot pick a name from here.
    expect(screen.queryByRole('button', { name: 'Alex Lee' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue as Jordan Smith · #7 · QB' }));

    await waitFor(() => expect(onChoose).toHaveBeenCalledWith(remembered, true));
  });

  it('"Not you?" hands back to the roster', async () => {
    const user = userEvent.setup();
    const onForget = vi.fn();
    render(
      <NameStep
        quizTitle="Week 1 Prep"
        rosterPlayers={rosterPlayers}
        remembered={{ playerId: 501, name: 'Jordan Smith', jerseyNumber: '7', position: 'QB' }}
        onChoose={vi.fn()}
        onForgetRemembered={onForget}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Not you? Choose your name' }));

    expect(onForget).toHaveBeenCalled();
  });

  it("shows a roster player's photo when set, and initials otherwise - helps tell same-name Players apart", () => {
    const { container } = render(
      <NameStep quizTitle="Week 1 Prep" rosterPlayers={rosterPlayersWithPhotos} onChoose={vi.fn()} />,
    );

    const jordanButton = screen.getByRole('button', { name: 'Jordan Smith (#7 · QB)' });
    const chrisButton = screen.getByRole('button', { name: 'Chris Smith (#9 · WR)' });
    expect(jordanButton.querySelector('img')).not.toBeNull();
    expect(chrisButton.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('disables the Continue button until a name is selected', () => {
    render(<NameStep quizTitle="Week 1 Prep" rosterPlayers={rosterPlayers} onChoose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });
});
