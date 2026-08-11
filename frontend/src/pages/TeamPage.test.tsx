import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamPage } from './TeamPage';
import * as orgApi from '../api/organizations';
import * as authContext from '../auth/AuthContext';
import { acceptConfirm, cancelConfirm } from '../test/confirmDialog';
import type { Coach, Organization, OrganizationInvite } from '../api/types';

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

const org: Organization = {
  id: 1,
  name: 'Wildcats',
  members: [
    { id: 1, username: 'coach1', email: 'coach1@example.com', role: 'admin' },
    { id: 2, username: 'assistant', email: 'assistant@example.com', role: 'member' },
  ],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const invite: OrganizationInvite = {
  id: 5,
  organization_id: 1,
  created_at: '2026-01-01T00:00:00Z',
  expires_at: '2026-02-01T00:00:00Z',
  accepted_at: null,
  is_revoked: false,
  is_usable: true,
  created_by: 'coach1',
  accepted_by: null,
};

function mockAuth(coach: Coach) {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    coach,
    isLoading: false,
    login: vi.fn(),
    register: vi.fn(),
    registerWithInvite: vi.fn(),
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

describe('TeamPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the organization and its members', async () => {
    mockAuth(adminCoach);
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(org);
    vi.spyOn(orgApi, 'listInvites').mockResolvedValue([]);
    renderTeam();

    expect(await screen.findByText('Wildcats')).toBeInTheDocument();
    expect(screen.getByText('coach1')).toBeInTheDocument();
    expect(screen.getByText('assistant')).toBeInTheDocument();
  });

  it('shows admin-only controls for an admin', async () => {
    mockAuth(adminCoach);
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(org);
    vi.spyOn(orgApi, 'listInvites').mockResolvedValue([]);
    renderTeam();

    await screen.findByText('Wildcats');
    expect(screen.getByRole('button', { name: 'Create invite link' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Remove' }).length).toBeGreaterThan(0);
  });

  it('hides admin-only controls for a member', async () => {
    mockAuth(memberCoach);
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(org);
    const listInvitesSpy = vi.spyOn(orgApi, 'listInvites');
    renderTeam();

    await screen.findByText('Wildcats');
    expect(screen.queryByRole('button', { name: 'Create invite link' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    // Members never call the admin-only invites endpoint at all.
    expect(listInvitesSpy).not.toHaveBeenCalled();
  });

  it('creates an invite and shows the copyable link', async () => {
    const user = userEvent.setup();
    mockAuth(adminCoach);
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(org);
    vi.spyOn(orgApi, 'listInvites').mockResolvedValue([]);
    vi.spyOn(orgApi, 'createInvite').mockResolvedValue({ ...invite, code: 'secret-code-123' });
    renderTeam();

    await screen.findByText('Wildcats');
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));

    const linkInput = await screen.findByDisplayValue(/secret-code-123/);
    expect(linkInput).toBeInTheDocument();
  });

  it('revokes a pending invite after confirming', async () => {
    const user = userEvent.setup();
    mockAuth(adminCoach);
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(org);
    vi.spyOn(orgApi, 'listInvites').mockResolvedValue([invite]);
    const revokeSpy = vi.spyOn(orgApi, 'revokeInvite').mockResolvedValue(undefined);
    renderTeam();

    await screen.findByText('Wildcats');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent('stop working');
    await acceptConfirm(user, 'Revoke Invite');
    await waitFor(() => expect(revokeSpy).toHaveBeenCalledWith(5));
  });

  it('does not revoke the invite if the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    mockAuth(adminCoach);
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(org);
    vi.spyOn(orgApi, 'listInvites').mockResolvedValue([invite]);
    const revokeSpy = vi.spyOn(orgApi, 'revokeInvite').mockResolvedValue(undefined);
    renderTeam();

    await screen.findByText('Wildcats');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await cancelConfirm(user);

    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it("promotes a member to admin", async () => {
    const user = userEvent.setup();
    mockAuth(adminCoach);
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(org);
    vi.spyOn(orgApi, 'listInvites').mockResolvedValue([]);
    const roleSpy = vi
      .spyOn(orgApi, 'updateMemberRole')
      .mockResolvedValue({ id: 2, username: 'assistant', email: 'assistant@example.com', role: 'admin' });
    renderTeam();

    await screen.findByText('Wildcats');
    await user.click(screen.getByRole('button', { name: 'Make admin' }));

    await waitFor(() => expect(roleSpy).toHaveBeenCalledWith(2, 'admin'));
  });

  it('removes a member after confirming', async () => {
    const user = userEvent.setup();
    mockAuth(adminCoach);
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(org);
    vi.spyOn(orgApi, 'listInvites').mockResolvedValue([]);
    const removeSpy = vi.spyOn(orgApi, 'removeMember').mockResolvedValue(undefined);
    renderTeam();

    await screen.findByText('Wildcats');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await acceptConfirm(user, 'Remove Coach');

    await waitFor(() => expect(removeSpy).toHaveBeenCalledWith(2));
  });

  it('never shows a Remove button next to the signed-in coach themselves', async () => {
    mockAuth(adminCoach);
    vi.spyOn(orgApi, 'getOrganization').mockResolvedValue(org);
    vi.spyOn(orgApi, 'listInvites').mockResolvedValue([]);
    renderTeam();

    await screen.findByText('Wildcats');
    // Only "assistant" (id 2) gets a Remove button - not coach1 (id 1, self).
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(1);
  });
});
