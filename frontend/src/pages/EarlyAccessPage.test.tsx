import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EarlyAccessPage } from './EarlyAccessPage';
import * as authContext from '../auth/AuthContext';

function renderPage(path = '/register') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/register" element={<EarlyAccessPage />} />
        <Route path="/request-access" element={<p>Request access screen</p>} />
        <Route path="/invite/:token" element={<p>Invite screen</p>} />
        <Route path="/login" element={<p>Login screen</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('EarlyAccessPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // NotebookHeader reads the auth context; this page does not.
    vi.spyOn(authContext, 'useAuth').mockReturnValue({
      coach: null,
      isLoading: false,
      login: vi.fn(),
      registerWithInvite: vi.fn(),
      registerWithBetaInvite: vi.fn(),
      logout: vi.fn(),
    });
  });

  it('SAYS WHAT PEIRA IS AND OFFERS EXACTLY TWO PATHS', () => {
    // A coach either has an invitation or does not. There is no third case, so
    // there is nothing else on this page to read.
    renderPage();

    expect(screen.getByRole('heading', { name: /early access/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request early access' })).toBeInTheDocument();
    expect(screen.getByLabelText('Have an invite code?')).toBeInTheDocument();
  });

  it('NO LONGER OFFERS A GENERIC SIGNUP FORM', () => {
    // /register used to create an organization for anyone who filled it in,
    // which contradicted the product actually being run.
    renderPage();

    expect(screen.queryByLabelText(/^Password/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Organization|Program name/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign ?up|Create account/i })).not.toBeInTheDocument();
  });

  it('sends somebody without an invite to the request form', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('link', { name: 'Request early access' }));

    expect(await screen.findByText('Request access screen')).toBeInTheDocument();
  });

  it('carries a hand-typed code straight to the invite screen', async () => {
    // The rare path: a code given by voice or on paper. An invited coach opens
    // their own link and never reaches this page.
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Have an invite code?'), 'PEIRA-2345-6789-ABCD');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Invite screen')).toBeInTheDocument();
  });

  it('DOES NOT VALIDATE THE CODE ITSELF', async () => {
    // The invite screen and the server already decide what a valid code is.
    // A second opinion here is how two definitions start disagreeing - so
    // anything non-empty is carried through and judged there.
    const user = userEvent.setup();
    renderPage();

    await user.type(screen.getByLabelText('Have an invite code?'), 'not a real code');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Invite screen')).toBeInTheDocument();
  });

  it('will not submit an empty code', async () => {
    renderPage();

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  });

  it('READS AS A FACT, NOT A VELVET ROPE', () => {
    // Peira is being built alongside a few programs. That is the whole reason
    // and it is enough - no countdown, no waitlist position, no "selected".
    renderPage();

    expect(document.body.textContent).not.toMatch(
      /selected|exclusive|limited time|spots? (left|remaining)|waitlist|hurry|apply now/i,
    );
  });

  it('still lets an existing coach reach the login screen', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('link', { name: 'Log in' }));

    expect(await screen.findByText('Login screen')).toBeInTheDocument();
  });
});
