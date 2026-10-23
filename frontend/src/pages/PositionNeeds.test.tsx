import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as playersApi from '../api/players';
import * as repsApi from '../api/reps';
import * as rosterApi from '../api/roster';
import * as conceptsApi from '../api/concepts';
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

  const q = (id: number, conceptId: number, text: string) => ({
    id,
    question_text: text,
    question_type: 'multiple_choice',
    concept: { id: conceptId, name: '', is_archived: false },
    image: { id, image_url: `/uploads/${id}.png` },
    options: [
      { id: id * 10, option_text: 'Rotate down', is_correct_answer: true },
      { id: id * 10 + 1, option_text: 'Stay', is_correct_answer: false },
    ],
    answer_explanation: `Why ${id}`,
    is_retired: false,
  });
  const QUIZ_30 = { id: 30, title: 'Boundary safety', questions: [q(70, 5, 'Rotate or stay?'), q(71, 5, 'Who is #3 now?'), q(72, 6, 'Not this concept')] };
  // Quiz 31 holds the retest copy of question 70 (copied from it) - the same football.
  const QUIZ_31 = { id: 31, title: 'Week 6 install', questions: [{ ...q(80, 5, 'Rotate or stay?'), copied_from_question_id: 70 }, q(81, 6, 'Deep third?')] };

  /** What the one teach read answers for these quizzes: the concept's questions, each with its quiz. */
  const footballFrom = (quizzes: { id: number; title: string; questions: ReturnType<typeof q>[] }[]) =>
    vi.spyOn(conceptsApi, 'getConceptFootball').mockImplementation(async (conceptId: number, ids: number[] = []) => {
      const asked = quizzes.filter((z) => ids.length === 0 || ids.includes(z.id));
      return {
        quizzes: asked.map((z) => ({ id: z.id, title: z.title, kind: 'QUIZ', retest_of: null })),
        questions: asked.flatMap((z) => z.questions.filter((x) => x.concept.id === conceptId).map((x) => ({ ...x, quiz_id: z.id }))),
      } as never;
    });

  it('names who, each opening his profile', async () => {
    renderNeeds();
    const panel = await screen.findByRole('region', { name: 'What your safeties need' });
    expect(within(panel).getByRole('link', { name: 'Bo X' })).toHaveAttribute('href', '/roster/2');
  });

  it('Teach opens right here: the football they missed, who, Retest them', async () => {
    const read = footballFrom([QUIZ_30, QUIZ_31]);
    renderNeeds();
    fireEvent.click(await screen.findByRole('button', { name: 'Teach' }));
    const teach = within(await screen.findByRole('dialog', { name: 'Teach Motion adjustment' }));
    expect(teach.getByText('2 of 3 still working on it')).toBeInTheDocument();
    expect(teach.getByText('Bo X, Ty X')).toBeInTheDocument();
    // Newest miss first (quiz 30: 70, 71); quiz 31's copy of the same football is taught once.
    expect(teach.getByText('Rotate or stay?')).toBeInTheDocument();
    expect(teach.getAllByRole('button', { name: /^[0-9]$/ }).map((b) => b.textContent)).toEqual(['1', '2']);
    expect(teach.getByRole('button', { name: 'Retest the 2' })).toBeInTheDocument();
    expect(landed).toBe('');
    // One read for every quiz they missed it in - not one whole quiz per source.
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(5, [30, 31]);
  });

  it('two different football questions worded alike are both taught - only a copy of the same question is merged', async () => {
    const distinct = { id: 31, title: 'Week 6 install', questions: [q(80, 5, 'Rotate or stay?'), q(81, 6, 'Deep third?')] };
    footballFrom([QUIZ_30, distinct]);
    renderNeeds();
    fireEvent.click(await screen.findByRole('button', { name: 'Teach' }));
    const teach = within(await screen.findByRole('dialog', { name: 'Teach Motion adjustment' }));
    // 70 and 71 from the Rep, and 80 - worded like 70 but its own football.
    expect(teach.getAllByRole('button', { name: /^[0-9]$/ }).map((b) => b.textContent)).toEqual(['1', '2', '3']);
  });

  it("Next teaches the group's next problem in the same screen", async () => {
    footballFrom([QUIZ_30, QUIZ_31]);
    vi.mocked(playersApi.getGroupNeeds).mockResolvedValue({
      players: 3,
      concepts: [
        NEEDS.concepts[0],
        { concept_id: 6, name: 'Cover 3 rotation', got: 2, missing: [{ player_id: 3, name: 'Cam X', last: event({ concept_id: 6, quiz_id: 31, kind: 'QUIZ', question_ids: [81] }) }] },
      ],
    });
    renderNeeds();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Teach' }))[0]);
    const first = within(await screen.findByRole('dialog', { name: 'Teach Motion adjustment' }));
    fireEvent.click(first.getByRole('button', { name: /Next: Cover 3 rotation · 1 of 3/ }));
    const second = within(await screen.findByRole('dialog', { name: 'Teach Cover 3 rotation' }));
    expect(second.getByText('Deep third?')).toBeInTheDocument();
    expect(second.getByText('1 of 3 still working on it')).toBeInTheDocument();
  });

  it('with no football to show here, Teach goes where the latest of them missed it', async () => {
    footballFrom([{ id: 30, title: 'x', questions: [] }]);
    renderNeeds();
    fireEvent.click(await screen.findByRole('button', { name: 'Teach' }));
    await waitFor(() => expect(landed).toBe('/reps/30?teach=5'));
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
    expect(await screen.findByText(/No misses on what you.ve tested them on/)).toBeInTheDocument();
  });

  it('a miss with nothing a Rep can re-ask (a written answer) offers Teach, not Retest', async () => {
    vi.mocked(playersApi.getGroupNeeds).mockResolvedValue({
      players: 1,
      concepts: [{ ...NEEDS.concepts[0], missing: [{ player_id: 1, name: 'Ty X', last: event({ question_ids: [], kind: 'QUIZ', quiz_id: 31 }) }] }],
    });
    footballFrom([QUIZ_31]);
    renderNeeds();
    expect(screen.queryByRole('button', { name: /Retest/ })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Teach' }));
    const teach = within(await screen.findByRole('dialog', { name: 'Teach Motion adjustment' }));
    // Nothing he missed a Rep can re-ask: the concept's football, taught; no Retest.
    expect(teach.getByText('Rotate or stay?')).toBeInTheDocument();
    expect(teach.queryByRole('button', { name: /Retest/ })).toBeNull();
  });
});
