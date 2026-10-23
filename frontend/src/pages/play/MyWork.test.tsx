import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/play', () => ({ validateCode: vi.fn() }));
import * as playApi from '../../api/play';
import type { ValidateCodeResponse } from '../../api/types';
import { MyWork } from './MyWork';
import { rememberPlayer } from './playerSession';
import { progressOf, recordDone, recordStarted, reviewFrom } from './workProgress';

/** PLAYER HOME: what to do next, from the work on this device - one thing leads. */

const joined = (title: string, over: Partial<ValidateCodeResponse['quiz']> = {}, mode = 'PRACTICE'): ValidateCodeResponse =>
  ({
    access_code_id: 1,
    expires_at: '2026-10-25T18:00:00Z',
    mode,
    quiz: { id: 1, title, kind: 'QUIZ', questions: [], ...over },
    roster_players: [],
    roster_players_v2: [],
  }) as unknown as ValidateCodeResponse;

const marcus = { playerId: 21, name: 'Marcus Hill', jerseyNumber: '24', position: 'S' };

function home() {
  render(
    <MemoryRouter>
      <MyWork joinSlot={(secondary) => <input placeholder="CODE" aria-label="Code" data-secondary={secondary} />} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Player home', () => {
  it('with nothing played on this device, it is just the code box', () => {
    home();
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
    expect(screen.queryByLabelText('Up next')).toBeNull();
    expect(playApi.validateCode).not.toHaveBeenCalled();
  });

  it('leads with the one thing to do next: a retest first, then a rep, then a quiz', async () => {
    for (const code of ['QUIZ01', 'REP001', 'RETEST']) rememberPlayer(code, marcus);
    vi.mocked(playApi.validateCode).mockImplementation(async (code) =>
      code === 'RETEST'
        ? joined('Motion adjustment - Retest', { kind: 'REP', retest_of: { id: 9 } as never })
        : code === 'REP001'
          ? joined('Trips Jet - Boundary safety', { kind: 'REP' })
          : joined('Week 7 coverage', {}, 'GRADED'),
    );
    home();
    const next = within(await screen.findByLabelText('Up next'));
    expect(next.getByRole('heading', { name: 'Motion adjustment - Retest' })).toBeInTheDocument();
    expect(next.getByText(/Second look/)).toBeInTheDocument();
    expect(next.getByRole('link', { name: 'Start your rep' })).toHaveAttribute('href', '/play/RETEST');
    const also = within(screen.getByLabelText('Also waiting'));
    const rows = also.getAllByRole('link').map((a) => a.textContent);
    expect(rows[0]).toMatch(/Trips Jet/);
    expect(rows[1]).toMatch(/Week 7 coverage/);
    expect(screen.getByText('Hi, Marcus')).toBeInTheDocument();
    // A new code is always one box away.
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
  });

  it('in progress says Continue; finished with misses offers Review missed; finished clean drops off', async () => {
    for (const code of ['GOING1', 'MISSED', 'CLEAN1']) rememberPlayer(code, marcus);
    recordStarted('GOING1');
    recordDone('MISSED', 2, reviewFrom([1, 2], [
      { question_id: 1, auto_gradable: true, is_correct: false, answer_explanation: null },
      { question_id: 2, auto_gradable: true, is_correct: false, answer_explanation: null },
    ], { 1: [10], 2: [20] }));
    recordDone('CLEAN1', 0);
    vi.mocked(playApi.validateCode).mockImplementation(async (code) => joined(`Rep ${code}`, { kind: 'REP' }));
    home();
    // His own misses come before an assigned Rep (the owner's order).
    const next = within(await screen.findByLabelText('Up next'));
    expect(next.getByRole('link', { name: 'Review missed (2)' })).toHaveAttribute('href', '/play/MISSED?review=1');
    const also = within(screen.getByLabelText('Also waiting'));
    expect(also.getByRole('link', { name: /Rep GOING1/ })).toHaveAttribute('href', '/play/GOING1');
    expect(also.getByText('Continue')).toBeInTheDocument();
    expect(screen.queryByText(/Rep CLEAN1/)).toBeNull();
  });

  it('never offers a closed or unknown code - and the code box never waits on the check', async () => {
    rememberPlayer('GONE01', marcus);
    let fail!: (e: Error) => void;
    vi.mocked(playApi.validateCode).mockReturnValue(new Promise((_r, reject) => (fail = reject)));
    home();
    expect(screen.getByText('Finding your work…')).toBeInTheDocument();
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
    fail(new Error('This access code has expired'));
    await waitFor(() => expect(screen.queryByText('Finding your work…')).toBeNull());
    expect(screen.queryByLabelText('Up next')).toBeNull();
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
  });
});

describe('the progress kept on this device', () => {
  beforeEach(() => localStorage.clear());

  it('a new run replaces a finished one; a review keeps only the misses', () => {
    recordDone('ABC123', 1, reviewFrom([1, 2], [
      { question_id: 1, auto_gradable: true, is_correct: true, answer_explanation: null },
      { question_id: 2, auto_gradable: true, is_correct: false, answer_explanation: 'Why' },
    ], { 1: [10], 2: [21] }));
    expect(progressOf('abc123')).toMatchObject({ state: 'done', missed: 1, review: { missedIds: [2], chosen: { 2: [21] } } });
    recordStarted('ABC123');
    expect(progressOf('ABC123')).toMatchObject({ state: 'started', missed: 0 });
    expect(progressOf('ABC123')?.review).toBeUndefined();
  });
});

describe('the way back to his other work', () => {
  it('only when this device holds other work', async () => {
    const { OtherWorkLink } = await import('./OtherWorkLink');
    localStorage.clear();
    rememberPlayer('ONLY01', marcus);
    const { unmount } = render(
      <MemoryRouter>
        <OtherWorkLink code="ONLY01" />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('link', { name: /Your other work/ })).toBeNull();
    unmount();
    rememberPlayer('NEXT02', marcus);
    render(
      <MemoryRouter>
        <OtherWorkLink code="ONLY01" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Your other work/ })).toHaveAttribute('href', '/play');
  });
});

describe('a quiz retest is a second look too', () => {
  it('leads ahead of an ordinary rep', async () => {
    localStorage.clear();
    for (const code of ['REP001', 'QRETST']) rememberPlayer(code, marcus);
    vi.mocked(playApi.validateCode).mockImplementation(async (code) =>
      code === 'QRETST'
        ? joined('Coverage ID - Retest', { retest_of: { id: 3 } as never }, 'GRADED')
        : joined('Trips Jet - Boundary safety', { kind: 'REP' }),
    );
    home();
    const next = within(await screen.findByLabelText('Up next'));
    expect(next.getByRole('heading', { name: 'Coverage ID - Retest' })).toBeInTheDocument();
    expect(next.getByText(/Second look/)).toBeInTheDocument();
  });
});

describe('a graded quiz he missed some of', () => {
  it('comes back as Review missed, opening his results - and drops off when he missed nothing', async () => {
    localStorage.clear();
    for (const code of ['GRADE1', 'CLEAN2']) rememberPlayer(code, marcus);
    recordDone('GRADE1', 2, undefined, { graded: true });
    recordDone('CLEAN2', 0, undefined, { graded: true });
    vi.mocked(playApi.validateCode).mockImplementation(async (code) => joined(`Quiz ${code}`, {}, 'GRADED'));
    home();
    const next = within(await screen.findByLabelText('Up next'));
    expect(next.getByRole('heading', { name: 'Quiz GRADE1' })).toBeInTheDocument();
    expect(next.getByText(/Your results/)).toBeInTheDocument();
    expect(next.getByRole('link', { name: 'Review missed (2)' })).toHaveAttribute(
      'href',
      '/results/GRADE1/Marcus%20Hill?player_id=21',
    );
    expect(screen.queryByText(/Quiz CLEAN2/)).toBeNull();
  });

  it('his graded misses come before an assigned Rep', async () => {
    localStorage.clear();
    for (const code of ['GRADE1', 'REP001']) rememberPlayer(code, marcus);
    recordDone('GRADE1', 1, undefined, { graded: true });
    vi.mocked(playApi.validateCode).mockImplementation(async (code) =>
      code === 'REP001' ? joined('Trips Jet - Boundary safety', { kind: 'REP' }) : joined('Week 7 coverage', {}, 'GRADED'),
    );
    home();
    const next = within(await screen.findByLabelText('Up next'));
    expect(next.getByRole('heading', { name: 'Week 7 coverage' })).toBeInTheDocument();
    expect(next.getByRole('link', { name: 'Review missed (1)' })).toHaveAttribute('href', '/results/GRADE1/Marcus%20Hill?player_id=21');
    const also = within(screen.getByLabelText('Also waiting'));
    expect(also.getByRole('link', { name: /Trips Jet/ })).toHaveAttribute('href', '/play/REP001');
  });
});

describe('what to learn, and when there is nothing to do', () => {
  const withConcepts = (title: string, kind: 'REP' | 'QUIZ' = 'REP', mode = 'PRACTICE') =>
    joined(
      title,
      {
        kind,
        questions: [
          { id: 1, concept: { id: 3, name: 'Motion adjustment', is_archived: false } },
          { id: 2, concept: { id: 4, name: 'Coverage ID', is_archived: false } },
          { id: 5, concept: { id: 3, name: 'Motion adjustment', is_archived: false } },
        ] as never,
      },
      mode,
    );

  it('a review names the concepts he missed, once each, in the coach’s words', async () => {
    localStorage.clear();
    rememberPlayer('MISSED', marcus);
    recordDone('MISSED', 2, reviewFrom([1, 5], [
      { question_id: 1, auto_gradable: true, is_correct: false, answer_explanation: null },
      { question_id: 5, auto_gradable: true, is_correct: false, answer_explanation: null },
    ], { 1: [10], 5: [50] }));
    vi.mocked(playApi.validateCode).mockResolvedValue(withConcepts('Trips Jet'));
    home();
    const next = within(await screen.findByLabelText('Up next'));
    expect(next.getByText('Work on: Motion adjustment')).toBeInTheDocument();
  });

  it("a graded quiz's misses name theirs too", async () => {
    localStorage.clear();
    rememberPlayer('GRADE1', marcus);
    recordDone('GRADE1', 2, undefined, { graded: true, missedIds: [1, 2] });
    vi.mocked(playApi.validateCode).mockResolvedValue(withConcepts('Week 7 coverage', 'QUIZ', 'GRADED'));
    home();
    const next = within(await screen.findByLabelText('Up next'));
    expect(next.getByText('Work on: Motion adjustment, Coverage ID')).toBeInTheDocument();
  });

  it('with everything done and nothing missed, says so - above the code box', async () => {
    localStorage.clear();
    rememberPlayer('CLEAN1', marcus);
    recordDone('CLEAN1', 0);
    vi.mocked(playApi.validateCode).mockResolvedValue(withConcepts('Trips Jet'));
    home();
    expect(await screen.findByText('You’re all caught up.')).toBeInTheDocument();
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
  });

  it('a device with nothing played is just the code box - no caught-up line', () => {
    localStorage.clear();
    home();
    expect(screen.queryByText(/all caught up/)).toBeNull();
  });
});

describe('the code box is the second thing once he has played here', () => {
  it('secondary as soon as this device has played - before any check comes back', () => {
    localStorage.clear();
    rememberPlayer('REP001', marcus);
    vi.mocked(playApi.validateCode).mockReturnValue(new Promise(() => undefined));
    home();
    expect(screen.getByLabelText('Code')).toHaveAttribute('data-secondary', 'true');
  });

  it('first and focused on a device that has never played', () => {
    localStorage.clear();
    home();
    expect(screen.getByLabelText('Code')).toHaveAttribute('data-secondary', 'false');
  });
});

describe('the order a player should do things in', () => {
  it('a retest, then his misses (reviewing or retrying), then a Rep, then a graded quiz, then practice', async () => {
    localStorage.clear();
    for (const code of ['PRAC01', 'QUIZ01', 'REP001', 'RETRY1', 'RETEST']) rememberPlayer(code, marcus);
    recordStarted('RETRY1', { retry: true });
    vi.mocked(playApi.validateCode).mockImplementation(async (code) => {
      if (code === 'RETEST') return joined('Retest', { kind: 'REP', retest_of: { id: 9 } as never });
      if (code === 'RETRY1') return joined('Trips Jet misses', { kind: 'REP' });
      if (code === 'REP001') return joined('Bunch Rt', { kind: 'REP' });
      if (code === 'QUIZ01') return joined('Week 7 coverage', {}, 'GRADED');
      return joined('Practice install', {});
    });
    home();
    const next = within(await screen.findByLabelText('Up next'));
    expect(next.getByRole('heading', { name: 'Retest' })).toBeInTheDocument();
    const rows = within(screen.getByLabelText('Also waiting')).getAllByRole('link').map((a) => a.textContent);
    expect(rows[0]).toMatch(/Trips Jet misses/);
    expect(rows[0]).toMatch(/Your misses, again/);
    expect(rows[0]).toMatch(/Continue/);
    expect(rows[1]).toMatch(/Bunch Rt/);
    expect(rows[2]).toMatch(/Week 7 coverage/);
    expect(rows[3]).toMatch(/Practice install/);
  });
});
