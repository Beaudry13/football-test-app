import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpMenu } from '../HelpMenu';
import { TourProvider } from '../tour/TourProvider';
import { ReleaseNotes } from './ReleaseNotes';
import { LATEST_RELEASE_ID, RELEASES, hasUnreadReleases } from './releases';
import * as whatsNewApi from '../../api/whatsNew';

function renderMenu() {
  render(
    <MemoryRouter>
      <TourProvider>
        <HelpMenu />
      </TourProvider>
    </MemoryRouter>,
  );
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Help/ }));
  return user;
}

describe('release registry', () => {
  it('treats the newest entry as the latest release', () => {
    // Derived, never hand-maintained: shipping a release is one entry at the
    // top of the array, with no second constant anyone can forget to bump.
    expect(LATEST_RELEASE_ID).toBe(RELEASES[0].id);
  });

  it('gives every release a unique id within the column width', () => {
    const ids = RELEASES.map((r) => r.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(32);
  });

  it('counts a coach who has never opened it as unread', () => {
    // The case that matters at launch: every account that existed before
    // this shipped has null here, and nothing had to backfill it.
    expect(hasUnreadReleases(null)).toBe(true);
  });

  it('counts a coach on the newest release as up to date', () => {
    expect(hasUnreadReleases(LATEST_RELEASE_ID)).toBe(false);
  });

  it('counts a coach on an older release as unread', () => {
    expect(hasUnreadReleases(RELEASES[RELEASES.length - 1].id)).toBe(true);
  });

  it('seeds the history with what has actually shipped', () => {
    const text = RELEASES.flatMap((r) => [r.title, r.summary, ...r.changes])
      .join(' ')
      .toLowerCase();

    for (const feature of [
      'draw',
      'playbook',
      'tap',
      'admin view',
      'coach view',
      'folder',
      'performance',
      'checklist',
      'dashboard tour',
      'image',
    ]) {
      expect(text).toContain(feature);
    }
  });
});

describe('ReleaseNotes', () => {
  it('shows every release, newest first', () => {
    render(<ReleaseNotes />);

    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    expect(headings).toEqual(RELEASES.map((r) => r.title));
  });

  it('shows each release date and its changes', () => {
    render(<ReleaseNotes />);

    for (const release of RELEASES) {
      expect(screen.getByText(release.date)).toBeInTheDocument();
      for (const change of release.changes) {
        expect(screen.getByText(change)).toBeInTheDocument();
      }
    }
  });

  it('keeps older releases after the newest one is read', () => {
    // History is never trimmed - a coach joining in November should still be
    // able to read what changed in August.
    render(<ReleaseNotes />);

    expect(screen.getByText(RELEASES[RELEASES.length - 1].title)).toBeInTheDocument();
  });
});

describe('unread indicator', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(whatsNewApi, 'markWhatsNewSeen').mockResolvedValue({
      seen_version: LATEST_RELEASE_ID,
    });
  });

  it('shows on Help and beside What’s New when a coach has never opened it', async () => {
    vi.spyOn(whatsNewApi, 'getWhatsNew').mockResolvedValue({ seen_version: null });
    renderMenu();

    expect(await screen.findByLabelText('Unread updates')).toBeInTheDocument();
    await openMenu();
    expect(screen.getByText('New')).toBeInTheDocument();
  });

  it('shows for a coach who has only seen an older release', async () => {
    vi.spyOn(whatsNewApi, 'getWhatsNew').mockResolvedValue({ seen_version: '2026.01.1' });
    renderMenu();

    expect(await screen.findByLabelText('Unread updates')).toBeInTheDocument();
  });

  it('stays hidden for a coach who is up to date', async () => {
    vi.spyOn(whatsNewApi, 'getWhatsNew').mockResolvedValue({
      seen_version: LATEST_RELEASE_ID,
    });
    renderMenu();

    await screen.findByRole('button', { name: /Help/ });
    await waitFor(() =>
      expect(screen.queryByLabelText('Unread updates')).not.toBeInTheDocument(),
    );
  });

  it('never appears just because the request failed', async () => {
    // Fails closed. A dot that will not go away because the network hiccuped
    // is worse than one that never appears.
    vi.spyOn(whatsNewApi, 'getWhatsNew').mockRejectedValue(new Error('offline'));
    renderMenu();

    await screen.findByRole('button', { name: /Help/ });
    await waitFor(() =>
      expect(screen.queryByLabelText('Unread updates')).not.toBeInTheDocument(),
    );
  });
});

describe('opening What’s New', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(whatsNewApi, 'getWhatsNew').mockResolvedValue({ seen_version: null });
  });

  it('opens the release notes', async () => {
    vi.spyOn(whatsNewApi, 'markWhatsNewSeen').mockResolvedValue({
      seen_version: LATEST_RELEASE_ID,
    });
    renderMenu();
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: "What's New" }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "What's New" })).toBeInTheDocument();
    expect(screen.getByText(RELEASES[0].title)).toBeInTheDocument();
  });

  it('records the newest release as seen, server-side', async () => {
    const mark = vi
      .spyOn(whatsNewApi, 'markWhatsNewSeen')
      .mockResolvedValue({ seen_version: LATEST_RELEASE_ID });
    renderMenu();
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: "What's New" }));

    // Server-side, not localStorage - that is what makes it stay read on the
    // coach's other device.
    await waitFor(() => expect(mark).toHaveBeenCalledWith(LATEST_RELEASE_ID));
  });

  it('clears both indicators immediately', async () => {
    vi.spyOn(whatsNewApi, 'markWhatsNewSeen').mockResolvedValue({
      seen_version: LATEST_RELEASE_ID,
    });
    renderMenu();
    const user = await openMenu();
    expect(screen.getByText('New')).toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: "What's New" }));

    await waitFor(() =>
      expect(screen.queryByLabelText('Unread updates')).not.toBeInTheDocument(),
    );
  });

  it('still clears locally when the server never hears', async () => {
    vi.spyOn(whatsNewApi, 'markWhatsNewSeen').mockRejectedValue(new Error('offline'));
    renderMenu();
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: "What's New" }));

    // The coach did read them. The dot returns on the next load, which is
    // the right way round.
    await waitFor(() =>
      expect(screen.queryByLabelText('Unread updates')).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not mark anything seen when another article is opened', async () => {
    const mark = vi
      .spyOn(whatsNewApi, 'markWhatsNewSeen')
      .mockResolvedValue({ seen_version: LATEST_RELEASE_ID });
    renderMenu();
    const user = await openMenu();

    await user.click(screen.getByRole('menuitem', { name: 'Getting Started' }));

    expect(mark).not.toHaveBeenCalled();
  });

  it('never opens on its own', async () => {
    // Unread is an indicator, not an interruption.
    vi.spyOn(whatsNewApi, 'markWhatsNewSeen').mockResolvedValue({
      seen_version: LATEST_RELEASE_ID,
    });
    renderMenu();

    await screen.findByLabelText('Unread updates');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
