import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpMenu } from './HelpMenu';
import { HELP_ACTIONS, HELP_ENTRIES } from './registry';
import * as onboardingApi from '../api/onboarding';

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function renderMenu(initialPath = '/roster') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <HelpMenu />
      <LocationProbe />
      <Routes>
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Help' }));
  return user;
}

describe('HelpMenu', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists every topic the registry declares', async () => {
    // Asserted against the registry rather than a hardcoded list: the menu is
    // meant to be data-driven, and a test that repeats the list would pass
    // even if the menu stopped reading it.
    renderMenu();
    await openMenu();

    for (const entry of [...HELP_ENTRIES, ...HELP_ACTIONS]) {
      expect(screen.getByRole('menuitem', { name: entry.title })).toBeInTheDocument();
    }
  });

  it('covers the topics a new coach needs', async () => {
    renderMenu();
    await openMenu();

    for (const title of [
      'Getting Started',
      'Dashboard Tour',
      'Creating Your First Quiz',
      'Playbook Quiz',
      'Draw Response',
      'Folders & Organization',
      'Players & Groups',
      'Results & Analytics',
      'What is Peira?',
      "What's New",
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
  });

  it('opens an article', async () => {
    renderMenu();
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'Getting Started' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Getting Started' })).toBeInTheDocument();
  });

  it('opens the old "What is Peira?" content from Help', async () => {
    // The content moved rather than being dropped - this is the same copy the
    // standalone modal used to auto-open with.
    renderMenu();
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'What is Peira?' }));

    expect(screen.getByRole('heading', { name: 'What is Peira?' })).toBeInTheDocument();
    expect(screen.getByText(/trial, test, proof through experience/)).toBeInTheDocument();
  });

  it('disables what is not built yet instead of offering a dead button', async () => {
    renderMenu();
    await openMenu();

    expect(screen.getByRole('menuitem', { name: 'Dashboard Tour' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: "What's New" })).toBeDisabled();
    expect(screen.getAllByText('Coming soon')).toHaveLength(2);
  });

  it('does nothing when a pending entry is clicked', async () => {
    renderMenu();
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'Dashboard Tour' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The menu stays put rather than closing as though something happened.
    expect(screen.getByRole('menu', { name: 'Help' })).toBeInTheDocument();
  });

  it('closes on Escape and on a click outside', async () => {
    renderMenu();
    const user = await openMenu();
    expect(screen.getByRole('menu', { name: 'Help' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Help' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Help' }));
    await user.click(document.body);
    await waitFor(() =>
      expect(screen.queryByRole('menu', { name: 'Help' })).not.toBeInTheDocument(),
    );
  });
});

describe('HelpMenu restore checklist', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('clears the dismissal on the server, not in this browser', async () => {
    // The reason this is an API call and not a localStorage key: a coach who
    // hid the checklist on a laptop and restores it on a phone must get it
    // back on both.
    const restore = vi
      .spyOn(onboardingApi, 'restoreOnboarding')
      .mockResolvedValue({} as never);
    renderMenu();
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'Show Getting Started Checklist' }));

    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
  });

  it('takes the coach to the dashboard, where the checklist lives', async () => {
    vi.spyOn(onboardingApi, 'restoreOnboarding').mockResolvedValue({} as never);
    renderMenu('/roster');
    const user = await openMenu();
    expect(screen.getByTestId('location')).toHaveTextContent('/roster');

    await user.click(screen.getByRole('menuitem', { name: 'Show Getting Started Checklist' }));

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/dashboard'));
  });

  it('still navigates when the coach is already on the dashboard', async () => {
    // The case that makes "reappears immediately" true: a same-path navigation
    // still produces a new location key, which is what the checklist watches.
    vi.spyOn(onboardingApi, 'restoreOnboarding').mockResolvedValue({} as never);
    const keys: string[] = [];
    function KeyProbe() {
      keys.push(useLocation().key);
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <HelpMenu />
        <KeyProbe />
      </MemoryRouter>,
    );
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'Show Getting Started Checklist' }));

    await waitFor(() => expect(new Set(keys).size).toBeGreaterThan(1));
  });

  it('survives a failed restore without breaking the menu', async () => {
    vi.spyOn(onboardingApi, 'restoreOnboarding').mockRejectedValue(new Error('offline'));
    renderMenu();
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'Show Getting Started Checklist' }));

    // No crash, no navigation, and Help is still there to try again.
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/roster'));
    expect(screen.getByRole('button', { name: 'Help' })).toBeInTheDocument();
  });
});
