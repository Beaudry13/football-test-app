import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/reps', () => ({ getRepsSummary: vi.fn(), getConceptTrends: vi.fn().mockResolvedValue([]) }));
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
  worst: { name: 'Motion adjustment', concept_id: 3, missed: 4, responded: 11, most_common_wrong: 'Stay boundary' },
  signal: null,
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

  it('says how a retest went: still missed after it, fixed, with the change', async () => {
    vi.mocked(repsApi.getRepsSummary).mockResolvedValue([
      rep({
        id: 4,
        title: 'Motion adjustment - Retest',
        is_retest: true,
        signal: { kind: 'retest_missing', concept: 'Motion adjustment', missed: 1, responded: 3, before_pct: 64, now_pct: 67 },
      }),
      rep({
        id: 5,
        title: 'Red zone - Retest',
        is_retest: true,
        signal: { kind: 'retest_fixed', concept: 'Red zone check', missed: 0, responded: 2, before_pct: 50, now_pct: 100 },
      }),
    ]);
    open();
    const list = within(await screen.findByRole('list'));
    expect(list.getByRole('link', { name: /Motion adjustment - Retest/ }).textContent).toMatch(
      /Motion adjustment still missed by 1 of 3 after the retest · 64% → 67%/,
    );
    expect(list.getByRole('link', { name: /Red zone - Retest/ }).textContent).toMatch(/Red zone check fixed on the retest · 50% → 100%/);
  });

  it('leads with the one problem to deal with now, one tap from teaching it', async () => {
    vi.mocked(repsApi.getRepsSummary).mockResolvedValue([
      rep({
        id: 7,
        worst: { name: 'Motion adjustment', concept_id: 3, missed: 4, responded: 11, most_common_wrong: 'Stay boundary' },
        open_problem: { name: 'Coverage ID', concept_id: 5, missed: 3, responded: 11 },
      }),
    ]);
    open();
    const next = within(await screen.findByLabelText('Next up'));
    expect(next.getByText(/3 of 11 safeties missed/)).toBeInTheDocument();
    expect(next.getByText('Coverage ID')).toBeInTheDocument();
    expect(next.getByRole('link', { name: 'Teach it' })).toHaveAttribute('href', '/reps/7?teach=5');
  });

  it('with no reps yet, offers the one thing to do', async () => {
    vi.mocked(repsApi.getRepsSummary).mockResolvedValue([]);
    open();
    expect(await screen.findByRole('link', { name: 'Make a rep' })).toHaveAttribute('href', '/motion-lab');
  });

  it('with no reps, stays away from a coach who cannot make one from a play', async () => {
    vi.mocked(repsApi.getRepsSummary).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <RepsHomeCard inviteWhenEmpty={false} />
      </MemoryRouter>,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('region', { name: 'Reps' })).toBeNull();
  });

  it('stays out of the way when the summary cannot be loaded', async () => {
    vi.mocked(repsApi.getRepsSummary).mockRejectedValue(new Error('offline'));
    open();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('region', { name: 'Reps' })).toBeNull();
  });
});
