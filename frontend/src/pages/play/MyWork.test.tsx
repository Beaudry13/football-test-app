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
      <MyWork joinSlot={<input placeholder="CODE" aria-label="Code" />} />
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
    expect(next.getByText(/Retest - your second look/)).toBeInTheDocument();
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
    const next = within(await screen.findByLabelText('Up next'));
    expect(next.getByRole('link', { name: 'Continue' })).toHaveAttribute('href', '/play/GOING1');
    const also = within(screen.getByLabelText('Also waiting'));
    expect(also.getByRole('link', { name: /Rep MISSED/ })).toHaveAttribute('href', '/play/MISSED?review=1');
    expect(also.getByText('Review missed (2)')).toBeInTheDocument();
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
