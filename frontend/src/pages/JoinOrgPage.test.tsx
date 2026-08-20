import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JoinOrgPage } from './JoinOrgPage';
import * as authApi from '../api/auth';
import * as authContext from '../auth/AuthContext';

function renderJoin(inviteCode = 'abc123') {
  render(
    <MemoryRouter initialEntries={[`/join/${inviteCode}`]}>
      <Routes>
        <Route path="/join/:inviteCode" element={<JoinOrgPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockUnauthenticated(registerWithInvite = vi.fn()) {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    coach: null,
    isLoading: false,
    login: vi.fn(),
    register: vi.fn(),
    registerWithInvite,
    registerWithBetaInvite: vi.fn(),
    logout: vi.fn(),
  });
}

describe('JoinOrgPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUnauthenticated();
  });

  it('previews the organization name before the coach signs up', async () => {
    vi.spyOn(authApi, 'previewInvite').mockResolvedValue({ organization_name: 'Wildcats' });
    renderJoin();

    expect(await screen.findByText('Join Wildcats')).toBeInTheDocument();
  });

  it('shows a plain error for an invalid or expired invite, with no signup form', async () => {
    vi.spyOn(authApi, 'previewInvite').mockRejectedValue(
      new Error('That invitation link is invalid, expired, or has already been used'),
    );
    renderJoin();

    expect(
      await screen.findByText('That invitation link is invalid, expired, or has already been used'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
  });

  it('submits the invite code alongside the signup form', async () => {
    const user = userEvent.setup();
    vi.spyOn(authApi, 'previewInvite').mockResolvedValue({ organization_name: 'Wildcats' });
    const registerWithInvite = vi.fn().mockResolvedValue(undefined);
    mockUnauthenticated(registerWithInvite);
    renderJoin('the-real-code');

    await screen.findByText('Join Wildcats');
    await user.type(screen.getByLabelText('Username'), 'assistant_coach');
    await user.type(screen.getByLabelText('Email'), 'assistant@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: 'Join team' }));

    await waitFor(() =>
      expect(registerWithInvite).toHaveBeenCalledWith({
        username: 'assistant_coach',
        email: 'assistant@example.com',
        password: 'password123',
        invite_code: 'the-real-code',
      }),
    );
  });
});
