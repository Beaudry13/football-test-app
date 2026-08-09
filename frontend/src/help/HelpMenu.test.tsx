import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpMenu } from './HelpMenu';
import { TourProvider } from './tour/TourProvider';
import { HELP_ACTIONS, HELP_ENTRIES } from './registry';
import * as onboardingApi from '../api/onboarding';
import * as whatsNewApi from '../api/whatsNew';
import { LATEST_RELEASE_ID } from './whatsNew/releases';

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function renderMenu(initialPath = '/roster') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TourProvider>
        <HelpMenu />
        <LocationProbe />
        <Routes>
          <Route path="*" element={null} />
        </Routes>
      </TourProvider>
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
    // Default to "up to date" so the unread dot does not bleed into tests
    // that are about something else.
    vi.spyOn(whatsNewApi, 'getWhatsNew').mockResolvedValue({ seen_version: LATEST_RELEASE_ID });
    vi.spyOn(whatsNewApi, 'markWhatsNewSeen').mockResolvedValue({ seen_version: LATEST_RELEASE_ID });
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

  it('has nothing left marked Coming soon', async () => {
    // Every entry in the menu now does something. The 'pending' kind stays
    // in the registry for the next unbuilt topic.
    renderMenu();
    await openMenu();

    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Dashboard Tour' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: "What's New" })).toBeEnabled();
  });

  it('launches the dashboard tour', async () => {
    renderMenu('/dashboard');
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'Dashboard Tour' }));

    // Same tour the checklist's link starts - one implementation, two doors.
    expect(screen.getByTestId('dashboard-tour')).toBeInTheDocument();
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
    vi.spyOn(whatsNewApi, 'getWhatsNew').mockResolvedValue({ seen_version: LATEST_RELEASE_ID });
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
        <TourProvider>
          <HelpMenu />
          <KeyProbe />
        </TourProvider>
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
