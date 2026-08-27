import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestAccessPage } from './RequestAccessPage';
import * as authApi from '../api/auth';
import * as authContext from '../auth/AuthContext';

const RECEIVED = 'Thanks - we have your request and will be in touch.';

function renderPage() {
  render(
    <MemoryRouter>
      <RequestAccessPage />
    </MemoryRouter>,
  );
}

describe('RequestAccessPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // NotebookHeader reads the auth context. This page does not, but it wears
    // the same chrome as every other public page.
    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      coach: null,
      isLoading: false,
      login: vi.fn(),
      registerWithInvite: vi.fn(),
      registerWithBetaInvite: vi.fn(),
      logout: vi.fn(),
    });
  });

  it('asks for three things, and says which one is optional', () => {
    // THE SIMPLICITY CHECK, as a test. Everything asked here is asked before
    // this coach has any reason to trust Peira, so the count is pinned rather
    // than left to drift.
    renderPage();

    expect(screen.getAllByRole('textbox')).toHaveLength(3);
    expect(screen.getByLabelText(/Your name/)).toBeRequired();
    expect(screen.getByLabelText(/Email/)).toBeRequired();
    expect(screen.getByLabelText(/Team or program/)).not.toBeRequired();
    expect(screen.getByText('(optional)')).toBeInTheDocument();
  });

  it('sends what the coach typed', async () => {
    const send = vi.spyOn(authApi, 'requestAccess').mockResolvedValue({ message: RECEIVED });
    renderPage();

    await userEvent.type(screen.getByLabelText(/Your name/), 'Coach Smith');
    await userEvent.type(screen.getByLabelText(/Email/), 'smith@example.com');
    await userEvent.type(screen.getByLabelText(/Team or program/), 'Madeira Mustangs');
    await userEvent.click(screen.getByRole('button', { name: 'Request access' }));

    expect(send).toHaveBeenCalledWith({
      name: 'Coach Smith',
      email: 'smith@example.com',
      team: 'Madeira Mustangs',
    });
  });

  it('sends an empty team when the coach skips it', async () => {
    const send = vi.spyOn(authApi, 'requestAccess').mockResolvedValue({ message: RECEIVED });
    renderPage();

    await userEvent.type(screen.getByLabelText(/Your name/), 'Coach Smith');
    await userEvent.type(screen.getByLabelText(/Email/), 'smith@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Request access' }));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ team: '' }));
  });

  it('replaces the form with the confirmation the server sent', async () => {
    vi.spyOn(authApi, 'requestAccess').mockResolvedValue({ message: RECEIVED });
    renderPage();

    await userEvent.type(screen.getByLabelText(/Your name/), 'Coach Smith');
    await userEvent.type(screen.getByLabelText(/Email/), 'smith@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Request access' }));

    expect(await screen.findByText(RECEIVED)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request access' })).not.toBeInTheDocument();
  });

  it('SHOWS WHAT THE SERVER SAID RATHER THAN COMPOSING ITS OWN', async () => {
    // The security property lives on the server: one constant answer for a
    // new request, a repeat request and an address that already has an
    // account (see tests/test_access_requests.py::TestItRevealsNothing).
    //
    // The page's job is not to undo that. Anything it composed itself - "we
    // already have your request" - would put back exactly the oracle the
    // server refuses to be. So it renders what it was handed, and this is
    // what would fail if it ever stopped.
    vi.spyOn(authApi, 'requestAccess').mockResolvedValue({ message: 'Some other wording' });
    renderPage();

    await userEvent.type(screen.getByLabelText(/Your name/), 'Coach Smith');
    await userEvent.type(screen.getByLabelText(/Email/), 'smith@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Request access' }));

    expect(await screen.findByText('Some other wording')).toBeInTheDocument();
    expect(screen.queryByText(RECEIVED)).not.toBeInTheDocument();
  });

  it('shows an error and keeps the form when the request fails', async () => {
    vi.spyOn(authApi, 'requestAccess').mockRejectedValue(new Error('Something went wrong'));
    renderPage();

    await userEvent.type(screen.getByLabelText(/Your name/), 'Coach Smith');
    await userEvent.type(screen.getByLabelText(/Email/), 'smith@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Request access' }));

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request access' })).toBeInTheDocument();
  });

  it('never claims the coach now has an account', async () => {
    // Asking is not being let in, and the confirmation must not imply it is.
    vi.spyOn(authApi, 'requestAccess').mockResolvedValue({ message: RECEIVED });
    renderPage();

    await userEvent.type(screen.getByLabelText(/Your name/), 'Coach Smith');
    await userEvent.type(screen.getByLabelText(/Email/), 'smith@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Request access' }));
    await screen.findByText(RECEIVED);

    expect(document.body.textContent).not.toMatch(/dashboard|logged in|account created/i);
  });
});
