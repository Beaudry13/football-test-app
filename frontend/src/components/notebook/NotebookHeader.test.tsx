import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotebookHeader } from './NotebookHeader';
import { TourProvider } from '../../help/tour/TourProvider';
import * as authContext from '../../auth/AuthContext';
import type { Coach } from '../../api/types';

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

function mockAuth() {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    coach: currentCoach,
    isLoading: false,
    login: vi.fn(),
    register: vi.fn(),
    registerWithInvite: vi.fn(),
    registerWithBetaInvite: vi.fn(),
    logout: vi.fn(),
  });
}

function renderHeader() {
  render(
    <MemoryRouter>
      <TourProvider>
        <NotebookHeader />
      </TourProvider>
    </MemoryRouter>,
  );
}

describe('NotebookHeader help', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockAuth();
  });

  it('never opens anything on its own, however new the coach is', () => {
    // A modal used to auto-open here on a first visit. A new coach's first
    // screen is now the setup checklist on the dashboard, which is about the
    // work they came to do; the help content is theirs to open when they want
    // it, not something to put in front of them.
    renderHeader();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Welcome to Peira')).not.toBeInTheDocument();
  });

  it('leaves no first-run flag behind in localStorage', () => {
    // Nothing schedules anything any more, so nothing needs to remember it
    // has been seen. A stale key would only mislead the next reader.
    renderHeader();

    expect(localStorage.getItem('peira_onboarding_seen')).toBeNull();
  });

  it('offers Help, and no longer a standalone "What is Peira?" link', () => {
    // The old link's content is a Help article now. Two doors onto the same
    // material is how a help system starts to rot.
    renderHeader();

    expect(screen.getByRole('button', { name: 'Help' })).toBeInTheDocument();
    expect(screen.queryByText('What is Peira?')).not.toBeInTheDocument();
  });

  it('shows Help to a normal coach and to an admin alike', async () => {
    const user = userEvent.setup();
    renderHeader();
    expect(screen.getByRole('button', { name: 'Help' })).toBeInTheDocument();
    // A member sees no Admin View...
    expect(screen.queryByText('Admin View')).not.toBeInTheDocument();

    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      coach: { ...currentCoach, role: 'admin' },
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      registerWithInvite: vi.fn(),
      registerWithBetaInvite: vi.fn(),
      logout: vi.fn(),
    });
    cleanup();
    renderHeader();

    // ...an admin does, inside the account menu. It moved there with the rest
    // of the account cluster - name, log out, Owner - because none of those
    // are navigation between sections, and on a 375px phone the four of them
    // were the difference between a two-row header and a four-row one.
    await user.click(screen.getByRole('button', { name: `Account: ${currentCoach.username}` }));
    expect(screen.getByRole('menuitem', { name: 'Admin View' })).toBeInTheDocument();

    // ...but help is not a privilege.
    await user.click(screen.getByRole('button', { name: 'Help' }));
    expect(screen.getByRole('menu', { name: 'Help' })).toBeInTheDocument();
  });

  it('keeps the section links in the header and the account cluster out of it', async () => {
    // THE POINT OF THE CONSOLIDATION. Where a coach can GO stays visible;
    // who they are, which view they are in and how to leave go behind one
    // control. A regression here is the header growing back.
    const user = userEvent.setup();
    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      coach: { ...currentCoach, role: 'admin' },
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      registerWithInvite: vi.fn(),
      registerWithBetaInvite: vi.fn(),
      logout: vi.fn(),
    });
    renderHeader();

    for (const label of ['Quizzes', 'Playbooks', 'Team']) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('link', { name: 'Admin View' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: `Account: ${currentCoach.username}` }));
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();
  });

  it('does not show anything for a logged-out visitor', () => {
    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      coach: null,
      isLoading: false,
      login: vi.fn(),
      register: vi.fn(),
      registerWithInvite: vi.fn(),
      registerWithBetaInvite: vi.fn(),
      logout: vi.fn(),
    });
    renderHeader();

    expect(screen.queryByRole('button', { name: 'Help' })).not.toBeInTheDocument();
  });
});
