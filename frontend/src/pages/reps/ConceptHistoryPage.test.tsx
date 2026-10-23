import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/reps', () => ({ getConceptHistory: vi.fn(), createRepRetest: vi.fn() }));
vi.mock('../../api/accessCodes', () => ({ activateQuiz: vi.fn() }));
import * as repsApi from '../../api/reps';
import * as codesApi from '../../api/accessCodes';
import type { ConceptHistory } from '../../api/reps';
import { ConceptHistoryPage } from './ConceptHistoryPage';

/**
 * ONE FOOTBALL PROBLEM OVER TIME - a page, not a dashboard: the trend, the
 * next step (Teach / Retest), who is still missing it, the recent Reps.
 */

const point = (rep_id: number, pct: number, missed: number, is_retest = false) => ({
  rep_id,
  title: is_retest ? 'Motion adjustment - Retest' : `Trips Jet ${rep_id}`,
  at: '2026-10-1' + rep_id + 'T12:00:00Z',
  pct,
  responded: 11,
  missed,
  is_retest,
});

const HISTORY: ConceptHistory = {
  concept: { id: 3, name: 'Motion adjustment', is_archived: false },
  points: [point(1, 64, 4), point(2, 67, 3), point(4, 82, 2)],
  recent: [point(4, 82, 2), point(2, 67, 3), point(1, 64, 4)],
  still_missing: [
    { key: 'p7', player_id: 7, display_name: 'Cam Cole', rep_id: 4 },
    { key: 'n:Bo', player_id: null, display_name: 'Bo Brown', rep_id: 4 },
  ] as ConceptHistory['still_missing'],
  latest: { rep_id: 4, title: 'Trips Jet 4', missed: 2, responded: 11, taught: null, retest: null },
};

function Landed() {
  return <p>the retest&apos;s page</p>;
}

function open(history: ConceptHistory = HISTORY) {
  vi.mocked(repsApi.getConceptHistory).mockResolvedValue(history);
  render(
    <MemoryRouter initialEntries={['/reps/concepts/3']}>
      <Routes>
        <Route path="/reps/concepts/:conceptId" element={<ConceptHistoryPage />} />
        <Route path="/reps/:quizId" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(repsApi.createRepRetest).mockResolvedValue({ id: 9, player_count: 2 } as never);
  vi.mocked(codesApi.activateQuiz).mockResolvedValue({ code: 'NEW123' } as never);
});

describe('a football problem over time', () => {
  it('shows the trend, who is still missing it, and the recent reps', async () => {
    open();
    expect(await screen.findByRole('heading', { name: 'Motion adjustment' })).toBeInTheDocument();
    expect(repsApi.getConceptHistory).toHaveBeenCalledWith(3);
    expect(screen.getByLabelText('First-try trend')).toHaveTextContent('64% → 67% → 82%');
    const missing = within(screen.getByRole('region', { name: 'Still missing it' }));
    expect(missing.getByRole('link', { name: 'Cam Cole' })).toHaveAttribute('href', '/roster/7');
    expect(missing.getByText('Bo Brown')).toBeInTheDocument();
    const recent = within(screen.getByRole('region', { name: 'Recent reps' }));
    expect(recent.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/reps/4', '/reps/2', '/reps/1']);
  });

  it('Teach leads until it is taught; Teach opens it on the latest rep', async () => {
    open();
    const next = within(await screen.findByRole('region', { name: 'Next step' }));
    expect(next.getByText(/2 of 11 missed it on/)).toBeInTheDocument();
    const teach = next.getByRole('link', { name: 'Teach' });
    expect(teach).toHaveAttribute('href', '/reps/4?teach=3');
    expect(teach.className).toMatch(/btnPrimary/);
  });

  it('once taught, Retest leads - one tap builds it for the ones who missed it and opens it, ready to send', async () => {
    open({ ...HISTORY, latest: { ...HISTORY.latest!, taught: { at: '2026-10-16T15:00:00Z', by: 'coach1' } } });
    const next = within(await screen.findByRole('region', { name: 'Next step' }));
    expect(next.getByText(/Taught Oct 16 by coach1\. Now see if it stuck\./)).toBeInTheDocument();
    // The count is what this page knows: "Retest the 2".
    const retest = next.getByRole('button', { name: 'Retest the 2' });
    expect(retest.className).toMatch(/btnPrimary/);
    fireEvent.click(retest);
    // No confirm step: the new Rep's own Send rep says who gets it.
    expect(screen.queryByRole('group', { name: 'Retest' })).toBeNull();
    await waitFor(() => expect(screen.getByText("the retest's page")).toBeInTheDocument());
    expect(repsApi.createRepRetest).toHaveBeenCalledWith(4, 3);
    expect(codesApi.activateQuiz).not.toHaveBeenCalled();
  });

  it('a Retest that cannot be built says why on the button, and stays on this page', async () => {
    vi.mocked(repsApi.createRepRetest).mockRejectedValue(new Error('Nobody left to retest'));
    open();
    const next = within(await screen.findByRole('region', { name: 'Next step' }));
    fireEvent.click(next.getByRole('button', { name: 'Retest the 2' }));
    expect(await next.findByRole('alert')).toHaveTextContent('Nobody left to retest');
    expect(next.getByRole('button', { name: 'Retest the 2 - try again' })).toHaveAttribute('title', 'Nobody left to retest');
    expect(screen.queryByText("the retest's page")).toBeNull();
    expect(codesApi.activateQuiz).not.toHaveBeenCalled();
  });

  it('a retest already out is opened, not sent again', async () => {
    const retest = { id: 9, title: 'Motion adjustment - Retest', invited: 2, ran: 1, responded: 1, missed: 1 };
    open({ ...HISTORY, latest: { ...HISTORY.latest!, retest } });
    const next = within(await screen.findByRole('region', { name: 'Next step' }));
    expect(next.getByText('Retest: 1 of 1 still missing.')).toBeInTheDocument();
    expect(next.getByRole('link', { name: 'Open retest' })).toHaveAttribute('href', '/reps/9');
    expect(next.queryByRole('button', { name: /^Retest/ })).toBeNull();
  });

  it('a problem none of your reps has tested says so', async () => {
    open({ ...HISTORY, points: [], recent: [], still_missing: [], latest: null });
    expect(await screen.findByText('None of your reps has tested this yet.')).toBeInTheDocument();
  });
});
