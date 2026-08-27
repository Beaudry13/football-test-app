import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BetaInvitePage } from './BetaInvitePage';
import * as authContext from '../auth/AuthContext';

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const TOKEN = 'PEIRA-2345-6789-ABCD';

function renderInvite(token = TOKEN) {
  render(
    <MemoryRouter initialEntries={[`/invite/${token}`]}>
      <Routes>
        <Route path="/invite/:token" element={<BetaInvitePage />} />
        <Route path="/dashboard" element={<p>Dashboard</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function mockUnauthenticated(registerWithBetaInvite = vi.fn()) {
  vi.spyOn(authContext, 'useAuth').mockReturnValue({
    coach: null,
    isLoading: false,
    login: vi.fn(),
    registerWithInvite: vi.fn(),
    registerWithBetaInvite,
    logout: vi.fn(),
  });
  return registerWithBetaInvite;
}

async function fillIn() {
  await userEvent.type(screen.getByLabelText('Your name'), 'coachsmith');
  await userEvent.type(screen.getByLabelText('Email'), 'smith@example.com');
  await userEvent.type(screen.getByLabelText('Password'), 'password123');
  await userEvent.type(screen.getByLabelText('Program name'), 'Madeira Mustangs');
}

describe('BetaInvitePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    navigate.mockClear();
  });

  it('asks for exactly four things and nothing else', async () => {
    // THE SIMPLICITY CHECK, as a test. Every field added here is a field a
    // coach has to answer before they have seen the product work once, so the
    // count is pinned rather than left to drift.
    mockUnauthenticated();
    renderInvite();

    expect(screen.getAllByRole('textbox')).toHaveLength(3); // name, email, program
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Your name')).toBeInTheDocument();
    expect(screen.getByLabelText('Program name')).toBeInTheDocument();
  });

  it('creates the account and the program from the token in the url', async () => {
    const signUp = mockUnauthenticated(vi.fn().mockResolvedValue(undefined));
    renderInvite();
    await fillIn();

    await userEvent.click(screen.getByRole('button', { name: 'Create my Peira' }));

    expect(signUp).toHaveBeenCalledWith({
      username: 'coachsmith',
      email: 'smith@example.com',
      password: 'password123',
      organization: 'Madeira Mustangs',
      invite_code: TOKEN,
    });
  });

  it('sends the token exactly as it appears in the url', async () => {
    // The server forgives case and dashes, so the page does not need to - and
    // must not, because normalising in two places is how the two definitions
    // drift apart.
    const signUp = mockUnauthenticated(vi.fn().mockResolvedValue(undefined));
    renderInvite('peira23456789abcd');
    await fillIn();

    await userEvent.click(screen.getByRole('button', { name: 'Create my Peira' }));

    expect(signUp).toHaveBeenCalledWith(
      expect.objectContaining({ invite_code: 'peira23456789abcd' }),
    );
  });

  it('LEAVES THE SPENT TOKEN OUT OF HISTORY once it has worked', async () => {
    // `replace`, not a push. The invite is a used-up credential; a back button
    // that returns to a URL containing it keeps it on screen for no reason.
    mockUnauthenticated(vi.fn().mockResolvedValue(undefined));
    renderInvite();
    await fillIn();

    await userEvent.click(screen.getByRole('button', { name: 'Create my Peira' }));

    expect(navigate).toHaveBeenCalledWith('/dashboard', { replace: true });
  });

  it('shows what the server said when the invite does not work, and stays put', async () => {
    mockUnauthenticated(vi.fn().mockRejectedValue(new Error('That invite code is not valid.')));
    renderInvite();
    await fillIn();

    await userEvent.click(screen.getByRole('button', { name: 'Create my Peira' }));

    expect(await screen.findByText('That invite code is not valid.')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('lets a coach try again after a failure', async () => {
    // A rejected signup does not spend the invite, so the button has to come
    // back - a form stuck on "Setting up…" would read as a dead invitation.
    const signUp = mockUnauthenticated(vi.fn().mockRejectedValue(new Error('Nope')));
    renderInvite();
    await fillIn();

    await userEvent.click(screen.getByRole('button', { name: 'Create my Peira' }));
    await screen.findByText('Nope');
    await userEvent.click(screen.getByRole('button', { name: 'Create my Peira' }));

    expect(signUp).toHaveBeenCalledTimes(2);
  });

  it('never shows the invite token on the page', async () => {
    // It is a credential. It has to travel in the URL to reach the page; it
    // does not have to be printed back at the coach as well.
    mockUnauthenticated();
    renderInvite();

    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
