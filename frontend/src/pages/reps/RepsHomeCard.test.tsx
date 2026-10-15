import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/reps', () => ({ getRepsSummary: vi.fn() }));
import * as repsApi from '../../api/reps';
import type { RepSummary } from '../../api/reps';
import { RepsHomeCard } from './RepsHomeCard';

/** REPS ON HOME: each recent Rep's worst football problem, one tap from its page. */

const rep = (over: Partial<RepSummary>): RepSummary => ({
  id: 1,
  title: 'Trips Jet - Boundary safety',
  decisions: 3,
  ran: 11,
  invited: 11,
  live: true,
  audience_label: 'Safeties',
  is_retest: false,
  worst: { name: 'Motion adjustment', missed: 4, responded: 11, most_common_wrong: 'Stay boundary' },
  ...over,
});

function open() {
  render(
    <MemoryRouter>
      <RepsHomeCard />
    </MemoryRouter>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('Reps on Home', () => {
  it('says each rep’s worst football problem and links to it', async () => {
    vi.mocked(repsApi.getRepsSummary).mockResolvedValue([
      rep({}),
      rep({ id: 2, title: 'Red zone - Mike', worst: null, ran: 0, invited: 9, live: true }),
      rep({ id: 3, title: 'Cover 2 - Corners', worst: null, ran: 6, invited: 6, live: false }),
    ]);
    open();
    const list = within(await screen.findByRole('list'));
    const first = list.getByRole('link', { name: /Trips Jet/ });
    expect(first).toHaveAttribute('href', '/reps/1');
    expect(first.textContent).toMatch(/Motion adjustment 4 of 11 safeties missed · most chose “Stay boundary”/);
    expect(list.getByRole('link', { name: /Red zone/ }).textContent).toMatch(/Waiting on players/);
    expect(list.getByRole('link', { name: /Cover 2/ }).textContent).toMatch(/Nobody missed a decision/);
  });

  it('with no reps yet, offers the one thing to do', async () => {
    vi.mocked(repsApi.getRepsSummary).mockResolvedValue([]);
    open();
    expect(await screen.findByRole('link', { name: 'Make a rep' })).toHaveAttribute('href', '/motion-lab');
  });

  it('stays out of the way when the summary cannot be loaded', async () => {
    vi.mocked(repsApi.getRepsSummary).mockRejectedValue(new Error('offline'));
    open();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('region', { name: 'Reps' })).toBeNull();
  });
});
