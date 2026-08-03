import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RootRoute } from './RootRoute';
import { AuthProvider } from './AuthContext';
import { clearToken, setToken } from '../api/client';
import * as authApi from '../api/auth';
import * as quizzesApi from '../api/quizzes';
import * as foldersApi from '../api/folders';
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

function renderRoot() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <RootRoute />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('RootRoute', () => {
  it('shows the public homepage at "/" when no one is signed in', async () => {
    clearToken();
    renderRoot();

    expect(await screen.findByRole('heading', { name: /Every trial has.*its coach/s })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign Up as a Coach' })).toHaveAttribute('href', '/register');
    expect(screen.queryByText('Your Trials')).not.toBeInTheDocument();
  });

  it('shows the coach dashboard at "/" once signed in', async () => {
    setToken('fake-token');
    vi.spyOn(authApi, 'me').mockResolvedValue(mockCoach);
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
    vi.spyOn(foldersApi, 'listFolders').mockResolvedValue([]);

    renderRoot();

    expect(await screen.findByText('Your Trials')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Every trial has/i })).not.toBeInTheDocument();

    clearToken();
  });
});
