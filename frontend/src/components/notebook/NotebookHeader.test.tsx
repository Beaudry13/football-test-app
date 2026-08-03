import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotebookHeader } from './NotebookHeader';
import * as authContext from '../../auth/AuthContext';
import type { Coach } from '../../api/types';

const currentCoach: Coach = {
  id: 1,
  username: 'coach1',
  email: 'coach1@example.com',
  organization: 'Wildcats',
  organization_id: 1,
  role: 'member',
  created_at: '2026-01-01T00:00:00Z',
};

function mockAuth() {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    coach: currentCoach,
    isLoading: false,
    login: vi.fn(),
    register: vi.fn(),
    registerWithInvite: vi.fn(),
    logout: vi.fn(),
  });
}

function renderHeader() {
  render(
    <MemoryRouter>
      <NotebookHeader />
    </MemoryRouter>,
  );
}

describe('NotebookHeader onboarding modal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockAuth();
  });

  it('shows the onboarding modal automatically the first time (nothing in localStorage yet)', () => {
    renderHeader();

    expect(screen.getByText('Welcome to Peira')).toBeInTheDocument();
  });

  it('dismisses on "Begin" and remembers that in localStorage', async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole('button', { name: 'Begin' }));

    expect(screen.queryByText('Welcome to Peira')).not.toBeInTheDocument();
    expect(localStorage.getItem('peira_onboarding_seen')).toBe('true');
  });

  it('does not auto-show again once already seen', () => {
    localStorage.setItem('peira_onboarding_seen', 'true');
    renderHeader();

    expect(screen.queryByText('Welcome to Peira')).not.toBeInTheDocument();
  });

  it('reopens via the "What is Peira?" link even after being dismissed', async () => {
    const user = userEvent.setup();
    localStorage.setItem('peira_onboarding_seen', 'true');
    renderHeader();
    expect(screen.queryByText('Welcome to Peira')).not.toBeInTheDocument();

    await user.click(screen.getByText('What is Peira?'));

    expect(screen.getByText('Welcome to Peira')).toBeInTheDocument();
  });

  it('does not show anything for a logged-out visitor', () => {
    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      coach: null,
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      registerWithInvite: vi.fn(),
      logout: vi.fn(),
    });
    renderHeader();

    expect(screen.queryByText('Welcome to Peira')).not.toBeInTheDocument();
    expect(screen.queryByText('What is Peira?')).not.toBeInTheDocument();
  });
});
