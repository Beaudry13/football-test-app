/** PLAYER PIN SECURITY, as a staff admin meets it: one switch on Team, what it
 *  warns before turning on, and the fact that an ordinary coach can read the
 *  policy but not change it. */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamPage } from './TeamPage';
import * as orgApi from '../api/organizations';
import * as authContext from '../auth/AuthContext';
import { acceptConfirm, cancelConfirm, findConfirmDialog } from '../test/confirmDialog';
import type { Coach, Organization } from '../api/types';

const adminCoach: Coach = {
  id: 1,
  username: 'coach1',
  email: 'coach1@example.com',
  organization: 'Wildcats',
  organization_id: 1,
  role: 'admin',
  is_platform_owner: false,
  created_at: '2026-01-01T00:00:00Z',
};
const memberCoach: Coach = { ...adminCoach, id: 2, username: 'assistant', role: 'member' };

const org = (over: Partial<Organization> = {}): Organization => ({
  id: 1,
  name: 'Wildcats',
  player_pin_security_enabled: false,
  players_without_pins: 0,
  members: [{ id: 1, username: 'coach1', email: 'coach1@example.com', role: 'admin' }],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

function mockAuth(coach: Coach) {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    coach,
    token: 't',
    isLoading: false,
    login: vi.fn(),
    register: vi.fn(),
    registerWithInvite: vi.fn(),
    registerWithBetaInvite: vi.fn(),
    logout: vi.fn(),
  });
}

function renderTeam() {
  render(
    <MemoryRouter>
      <TeamPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(orgApi, 'listInvites').mockResolvedValue([]);
});

describe('Player PIN Security setting', () => {
  it('is off by default, and says in plain words what it does', async () => {
    mockAuth(adminCoach);
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(org());
    renderTeam();

    expect(await screen.findByRole('heading', { name: 'Player PIN Security' })).toBeInTheDocument();
    expect(
      screen.getByText('Require players to enter a 6-digit PIN to protect their quiz attempts and results.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByText(/join with the access code and their name/)).toBeInTheDocument();
  });

  it('warns how many players still need a PIN before turning it on', async () => {
    const user = userEvent.setup();
    mockAuth(adminCoach);
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(org({ players_without_pins: 12 }));
    const save = vi
      .spyOn(orgApi, 'setPlayerPinSecurity')
      .mockResolvedValue(org({ player_pin_security_enabled: true, players_without_pins: 12 }));
    renderTeam();

    expect(await screen.findByText(/12 players don't have a PIN yet\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Turn on' }));

    const dialog = await findConfirmDialog();
    expect(dialog).toHaveTextContent("12 active players don't have a PIN yet");
    expect(dialog).toHaveTextContent('give them one from Team → Players');
    await acceptConfirm(user, 'Turn on');

    await waitFor(() => expect(save).toHaveBeenCalledWith(true));
  });

  it('can be cancelled, and then nothing is sent', async () => {
    const user = userEvent.setup();
    mockAuth(adminCoach);
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(org());
    const save = vi.spyOn(orgApi, 'setPlayerPinSecurity');
    renderTeam();

    await user.click(await screen.findByRole('button', { name: 'Turn on' }));
    await cancelConfirm(user);

    expect(save).not.toHaveBeenCalled();
  });

  it('turns off without a warning, because nothing is destroyed', async () => {
    const user = userEvent.setup();
    mockAuth(adminCoach);
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(org({ player_pin_security_enabled: true }));
    const save = vi.spyOn(orgApi, 'setPlayerPinSecurity').mockResolvedValue(org());
    renderTeam();

    expect(await screen.findByText('On')).toBeInTheDocument();
    expect(screen.getByText(/Quizzes cannot be activated for players who do not have one yet\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Turn off' }));

    await waitFor(() => expect(save).toHaveBeenCalledWith(false));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('an ordinary coach sees the policy but is given no switch', async () => {
    mockAuth(memberCoach);
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(org({ player_pin_security_enabled: true }));
    renderTeam();

    expect(await screen.findByText('On')).toBeInTheDocument();
    expect(screen.getByText('Only an organization admin can change this.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Turn o/ })).not.toBeInTheDocument();
  });
});
