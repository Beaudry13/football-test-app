import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/installs', () => ({ listInstalls: vi.fn() }));
import * as installsApi from '../../api/installs';
import type { InstallSummary } from '../../api/installs';
import { ThisWeek } from './ThisWeek';

/**
 * HOME'S ONE CONTINUATION LINE: the install he chose as current - never just
 * the one he edited last - one tap from opening or teaching it; without one,
 * the "pick up where you left off" line it stands in for. Never both.
 */

const summary = (over: Partial<InstallSummary> = {}): InstallSummary => ({
  id: 1,
  title: 'Week 7 - Central',
  position_group: null,
  archived: false,
  current: false,
  item_count: 4,
  counts: { plays: 2, quizzes: 0, reps: 1, concepts: 1 },
  created_at: '',
  updated_at: '',
  ...over,
});
const show = () =>
  render(
    <MemoryRouter>
      <ThisWeek fallback={<p>Pick up where you left off: Red zone</p>} />
    </MemoryRouter>,
  );

beforeEach(() => vi.clearAllMocks());

describe('Current install, on Home', () => {
  it('names the current install, opens it, and teaches it', async () => {
    vi.mocked(installsApi.listInstalls).mockResolvedValue([summary({ current: true }), summary({ id: 2, title: 'Spring install 4' })]);
    show();
    expect(screen.queryByText(/Current install/)).toBeNull();
    expect(await screen.findByRole('link', { name: 'Week 7 - Central' })).toHaveAttribute('href', '/installs/1');
    expect(screen.getByText(/Current install:/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Teach' })).toHaveAttribute('href', '/installs/1?teach=1');
    expect(screen.getByText(/2 plays · 1 Rep · 1 concept/)).toBeInTheDocument();
    expect(screen.queryByText(/Spring install 4/)).toBeNull();
    expect(screen.queryByText(/Pick up where you left off/)).toBeNull();
  });

  it('the install he edited last is not current just for that', async () => {
    // Spring install 4 was worked on most recently (first in the list) - Week 7 is still current.
    vi.mocked(installsApi.listInstalls).mockResolvedValue([summary({ id: 2, title: 'Spring install 4' }), summary({ current: true })]);
    show();
    expect(await screen.findByRole('link', { name: 'Week 7 - Central' })).toBeInTheDocument();
    expect(screen.queryByText(/Spring install 4/)).toBeNull();
  });

  it('an empty current install has nothing to teach yet', async () => {
    vi.mocked(installsApi.listInstalls).mockResolvedValue([summary({ current: true, item_count: 0, counts: { plays: 0, quizzes: 0, reps: 0, concepts: 0 } })]);
    show();
    expect(await screen.findByRole('link', { name: 'Week 7 - Central' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Teach' })).toBeNull();
  });

  it('installs, but none current: Home keeps its pick-up line', async () => {
    vi.mocked(installsApi.listInstalls).mockResolvedValue([summary(), summary({ id: 2, title: 'Spring install 4' })]);
    show();
    expect(await screen.findByText(/Pick up where you left off/)).toBeInTheDocument();
    expect(screen.queryByText(/Week 7 - Central/)).toBeNull();
  });

  it('no installs - or asking fails - the pick-up line', async () => {
    vi.mocked(installsApi.listInstalls).mockRejectedValue(new Error('offline'));
    show();
    expect(await screen.findByText(/Pick up where you left off/)).toBeInTheDocument();
  });
});
