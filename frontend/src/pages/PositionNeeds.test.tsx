import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as playersApi from '../api/players';
import * as repsApi from '../api/reps';
import * as rosterApi from '../api/roster';
import { MasterRosterPage } from './MasterRosterPage';
import { PositionNeeds } from './PositionNeeds';
import type { GroupNeeds, LearningEvent } from '../api/players';
import type { Player } from '../api/types';

/**
 * "SHOW ME MY SAFETIES. WHAT ARE THEY MISSING? SEND THOSE GUYS THIS WORK."
 * The roster filters by position group (Safeties = S, FS, SS, SAF), and under
 * it says what that group is still working on - who, Teach where they last
 * missed it, and Retest them: their missed decisions as one Rep for exactly
 * them, built and opened to send.
 */

const player = (id: number, first: string, position: string): Player =>
  ({
    id,
    organization_id: 1,
    first_name: first,
    last_name: 'X',
    full_name: `${first} X`,
    jersey_number: null,
    position,
    photo_url: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }) as Player;
const ROSTER = [player(1, 'Ty', 'FS'), player(2, 'Bo', 'SS'), player(3, 'Cam', 'S'), player(4, 'Dee', 'CB')];

const event = (over: Partial<LearningEvent> = {}): LearningEvent => ({
  concept_id: 5,
  outcome: 'missed',
  question_ids: [70],
  at: '2026-10-20T10:00:00Z',
  quiz_id: 30,
  quiz_title: 'Boundary safety',
  kind: 'REP',
  is_retest: false,
  ...over,
});
const NEEDS: GroupNeeds = {
  players: 3,
  concepts: [
    {
      concept_id: 5,
      name: 'Motion adjustment',
      got: 1,
      missing: [
        { player_id: 2, name: 'Bo X', last: event({ question_ids: [70, 71], at: '2026-10-21T10:00:00Z' }) },
        { player_id: 1, name: 'Ty X', last: event({ quiz_id: 31, kind: 'QUIZ', question_ids: [80], at: '2026-10-19T10:00:00Z' }) },
      ],
    },
  ],
};

let landed = '';
function Landed() {
  const location = useLocation();
  landed = `${location.pathname}${location.search}`;
  return <div>LANDED</div>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  landed = '';
  vi.spyOn(playersApi, 'listPlayers').mockResolvedValue(ROSTER);
  vi.spyOn(playersApi, 'getGroupNeeds').mockResolvedValue(NEEDS);
});

describe('the roster, by position group', () => {
  it('"Safeties" is everyone listed S, FS or SS - and under it, what they need', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MasterRosterPage />
      </MemoryRouter>,
    );
    await screen.findByText('Dee X');
    const filter = screen.getByRole('combobox', { name: 'Filter by position' });
    expect(within(filter).getByRole('option', { name: 'Safeties (FS, S, SS) · 3' })).toBeInTheDocument();
    await user.selectOptions(filter, 'family:Safeties');
    expect(screen.queryByText('Dee X')).toBeNull();
    expect(screen.getAllByText('Ty X').length).toBeGreaterThan(0);
    const panel = await screen.findByRole('region', { name: 'What your safeties need' });
    expect(playersApi.getGroupNeeds).toHaveBeenCalledWith([1, 2, 3]);
    expect(panel).toHaveTextContent('Motion adjustment');
    expect(panel).toHaveTextContent('2 of 3 still working on it');
  });

  it('no position picked, no panel', async () => {
    render(
      <MemoryRouter>
        <MasterRosterPage />
      </MemoryRouter>,
    );
    await screen.findByText('Dee X');
    expect(screen.queryByRole('region', { name: /need/ })).toBeNull();
    expect(playersApi.getGroupNeeds).not.toHaveBeenCalled();
  });
});

describe('what the group needs', () => {
  const renderNeeds = () =>
    render(
      <MemoryRouter initialEntries={['/team']}>
        <Routes>
          <Route path="/team" element={<PositionNeeds label="Safeties" plural="safeties" playerIds={[1, 2, 3]} />} />
          <Route path="/reps/:id" element={<Landed />} />
          <Route path="/quizzes/:id" element={<Landed />} />
          <Route path="/roster/:id" element={<Landed />} />
        </Routes>
      </MemoryRouter>,
    );

  it('names who, each opening his profile, and Teach goes where the latest of them missed it', async () => {
    renderNeeds();
    const panel = await screen.findByRole('region', { name: 'What your safeties need' });
    expect(within(panel).getByRole('link', { name: 'Bo X' })).toHaveAttribute('href', '/roster/2');
    expect(within(panel).getByRole('link', { name: 'Teach' })).toHaveAttribute('href', '/reps/30?teach=5');
  });

  it('Retest the 2: each one’s missed decisions as one Rep, for exactly them, opened to send', async () => {
    const make = vi.spyOn(repsApi, 'makeRepFromQuiz').mockResolvedValue({ id: 90 } as never);
    const add = vi.spyOn(repsApi, 'addDecisions').mockResolvedValue({} as never);
    const roster = vi.spyOn(rosterApi, 'addRosterMembers').mockResolvedValue({} as never);
    renderNeeds();
    fireEvent.click(await screen.findByRole('button', { name: 'Retest the 2' }));
    await waitFor(() => expect(roster).toHaveBeenCalledWith(90, [2, 1]));
    expect(make).toHaveBeenCalledWith(30, [70, 71], 'Motion adjustment - Safeties');
    expect(add).toHaveBeenCalledWith(90, 31, [80]);
    expect(landed).toBe('/reps/90');
  });

  it('nothing open says so plainly', async () => {
    vi.mocked(playersApi.getGroupNeeds).mockResolvedValue({ players: 3, concepts: [] });
    renderNeeds();
    expect(await screen.findByText('Nothing open on what you have tested them on.')).toBeInTheDocument();
  });

  it('a miss with nothing a Rep can re-ask (a written answer) offers Teach, not Retest', async () => {
    vi.mocked(playersApi.getGroupNeeds).mockResolvedValue({
      players: 1,
      concepts: [{ ...NEEDS.concepts[0], missing: [{ player_id: 1, name: 'Ty X', last: event({ question_ids: [], kind: 'QUIZ', quiz_id: 31 }) }] }],
    });
    renderNeeds();
    expect(await screen.findByRole('link', { name: 'Teach' })).toHaveAttribute('href', '/quizzes/31?tab=results&teach=5');
    expect(screen.queryByRole('button', { name: /Retest/ })).toBeNull();
  });
});
