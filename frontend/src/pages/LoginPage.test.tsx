import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';
import { AuthProvider } from '../auth/AuthContext';
import { clearToken } from '../api/client';
import * as authApi from '../api/auth';
import type { Coach } from '../api/types';

const mockCoach: Coach = {
  id: 1,
  username: 'coach_smith',
  email: 'coach@example.com',
  organization: 'Wildcats',
  organization_id: 1,
  role: 'admin',
  created_at: '2026-01-01T00:00:00Z',
};

function renderLoginPage() {
  render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>Dashboard</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    clearToken();
    vi.restoreAllMocks();
  });

  it('logs in and navigates to the dashboard on success', async () => {
    const user = userEvent.setup();
    vi.spyOn(authApi, 'login').mockResolvedValue({ coach: mockCoach, access_token: 'a-token' });
    renderLoginPage();

    await user.type(screen.getByLabelText('Email'), 'coach@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(screen.getByText('Dashboard')).toBeInTheDocument());
    expect(authApi.login).toHaveBeenCalledWith({ email: 'coach@example.com', password: 'password123' });
  });

  it('shows the server error and stays on the page when login fails', async () => {
    const user = userEvent.setup();
    vi.spyOn(authApi, 'login').mockRejectedValue(new Error('Invalid email or password'));
    renderLoginPage();

    await user.type(screen.getByLabelText('Email'), 'coach@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in' })).not.toBeDisabled();
  });
});
