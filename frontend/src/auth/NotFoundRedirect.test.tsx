import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundRedirect } from './NotFoundRedirect';
import * as authContext from './AuthContext';
import type { Coach } from '../api/types';

const currentCoach: Coach = {
  id: 1,
  username: 'coach1',
  email: 'coach1@example.com',
  organization: 'Wildcats',
  organization_id: 1,
  role: 'member',
  is_platform_owner: false,
  created_at: '2026-01-01T00:00:00Z',
};

function mockAuth(coach: Coach | null) {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    coach,
    isLoading: false,
    login: vi.fn(),
    register: vi.fn(),
    registerWithInvite: vi.fn(),
    logout: vi.fn(),
  });
}

function renderAtUnknownPath() {
  render(
    <MemoryRouter initialEntries={['/this-page-does-not-exist']}>
      <Routes>
        <Route path="/" element={<div>Marketing Homepage</div>} />
        <Route path="/dashboard" element={<div>Dashboard</div>} />
        <Route path="*" element={<NotFoundRedirect />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NotFoundRedirect', () => {
  it('sends an anonymous visitor to the marketing homepage', async () => {
    mockAuth(null);
    renderAtUnknownPath();

    expect(await screen.findByText('Marketing Homepage')).toBeInTheDocument();
  });

  it('sends a signed-in coach to their dashboard', async () => {
    mockAuth(currentCoach);
    renderAtUnknownPath();

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });
});
