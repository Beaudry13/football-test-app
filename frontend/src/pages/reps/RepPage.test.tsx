import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/reps', () => ({ getRepResults: vi.fn(), createRepRetest: vi.fn() }));
vi.mock('../../api/accessCodes', () => ({ activateQuiz: vi.fn() }));
vi.mock('../../api/groups', () => ({ listGroups: vi.fn() }));
vi.mock('../../api/questions', () => ({ updateQuestion: vi.fn() }));
import * as repsApi from '../../api/reps';
import * as codesApi from '../../api/accessCodes';
import * as groupsApi from '../../api/groups';
import * as questionsApi from '../../api/questions';
import * as authModule from '../../auth/AuthContext';
import type { RepResults } from '../../api/reps';
import { RepPage } from './RepPage';

/**
 * THE COACH'S SIDE OF A REP: not a grade, the football problem -
 * "MOTION ADJUSTMENT - 4 of 11 safeties missed - most chose 'Stay boundary'",
 * with View players, Teach and Retest.
 */

const person = (key: string, display_name: string) => ({ key, player_id: null, display_name, position: 'S', jersey_number: null });

const RESULTS: RepResults = {
  quiz_id: 5,
  title: 'Trips Jet - Boundary safety',
  players: [
    { ...person('p1', 'Marcus Hill'), correct: 1, answered: 2, attempts: 2, total_ms: 9000 },
    { ...person('p2', 'Devin Price'), correct: 2, answered: 2, attempts: 1, total_ms: 5000 },
  ],
  decisions: [
    {
      question_id: 11,
      number: 1,
      question_text: '#3 motions across. What is your check?',
      question_type: 'multiple_choice',
      subject_role: 'Boundary safety',
      concept: { id: 3, name: 'Motion adjustment' },
      motion_play_id: 14,
      answer_explanation: 'He is the new #3 - rotate down.',
      image: null,
      is_retired: false,
      correct_text: ['Rotate down'],
      responded: 11,
      missed: 4,
      median_ms: 4200,
      choices: [
        { option_id: 1, text: 'Rotate down', is_correct: true, count: 7, players: [] },
        { option_id: 2, text: 'Stay boundary', is_correct: false, count: 3, players: [] },
        { option_id: 3, text: 'Bail deep', is_correct: false, count: 1, players: [] },
      ],
      answers: [],
    },
  ],
  concepts: [
    {
      concept: { id: 3, name: 'Motion adjustment' },
      name: 'Motion adjustment',
      responded: 11,
      missed: 4,
      players_missed: [
        { ...person('p1', 'Marcus Hill'), answers: [{ question_id: 11, number: 1, chose: ['Stay boundary'], time_ms: 6100 }] },
        { ...person('p3', 'Caleb Reed'), answers: [{ question_id: 11, number: 1, chose: ['Bail deep'], time_ms: 3000 }] },
      ],
      most_common_wrong: { text: 'Stay boundary', question_id: 11, count: 3 },
      question_ids: [11],
      motion_play_id: 14,
    },
    {
      concept: { id: 4, name: 'Leverage' },
      name: 'Leverage',
      responded: 11,
      missed: 0,
      players_missed: [],
      most_common_wrong: null,
      question_ids: [],
      motion_play_id: null,
    },
  ],
  audience: { label: 'Safeties', invited: 11, code: 'KKFFQY', people: [] },
  retest_of: null,
};

function Landed() {
  return <p>the retest&apos;s page</p>;
}

function open(results: RepResults = RESULTS) {
  vi.mocked(repsApi.getRepResults).mockResolvedValue(results);
  render(
    <MemoryRouter initialEntries={['/reps/5']}>
      <Routes>
        <Route path="/reps/:quizId" element={<RepPage />} />
        <Route path="/reps/6" element={<Landed />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(groupsApi.listGroups).mockResolvedValue([{ id: 9, name: 'Safeties', players: new Array(11).fill({}) }] as never);
  vi.mocked(codesApi.activateQuiz).mockResolvedValue({ code: 'NEW123' } as never);
  vi.mocked(repsApi.createRepRetest).mockResolvedValue({ id: 6, player_count: 2 } as never);
});

describe('A Rep, for the coach', () => {
  it('names the football problem: how many of whom missed it, and what most chose', async () => {
    open();
    const card = within(await screen.findByRole('article', { name: 'Motion adjustment' }));
    expect(card.getByRole('heading', { name: 'Motion adjustment' })).toBeInTheDocument();
    expect(card.getByText(/safeties missed/).textContent).toMatch(/4 of 11 safeties missed · most chose “Stay boundary”/);
    expect(card.getByText('Marcus Hill')).toBeInTheDocument();
    // What they know is said too, briefly.
    expect(within(screen.getByRole('list', { name: 'What they know' })).getByText(/Leverage/)).toBeInTheDocument();
    // Live: the link to share.
    expect((screen.getByRole('textbox', { name: 'Rep link' }) as HTMLInputElement).value).toContain('/play/KKFFQY');
  });

  it("while it is out, says who hasn't run it", async () => {
    open({
      ...RESULTS,
      audience: { ...RESULTS.audience, people: [{ player_id: null, name: 'Marcus Hill' }, { player_id: null, name: 'Kobe Shaw' }] },
    });
    expect((await screen.findByText(/Hasn.t run it:/)).parentElement!.textContent).toMatch(/Kobe Shaw$/);
  });

  it('VIEW PLAYERS shows who missed it and what each one answered', async () => {
    open();
    const card = within(await screen.findByRole('article', { name: 'Motion adjustment' }));
    fireEvent.click(card.getByRole('button', { name: 'View players' }));
    const table = within(card.getByRole('table'));
    expect(table.getByText('Caleb Reed')).toBeInTheDocument();
    expect(table.getByText(/Bail deep/)).toBeInTheDocument();
    expect(table.getByText('6.1 s')).toBeInTheDocument();
  });

  it('TEACH shows the decision with the right answer and the reason, and the play it came from', async () => {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: true } } as never);
    open();
    const card = within(await screen.findByRole('article', { name: 'Motion adjustment' }));
    fireEvent.click(card.getByRole('button', { name: 'Teach' }));
    const teach = within(screen.getByRole('dialog', { name: 'Teach Motion adjustment' }));
    expect(teach.getByText('Rotate down')).toBeInTheDocument();
    expect(teach.getByText('He is the new #3 - rotate down.')).toBeInTheDocument();
    expect(teach.getByText('3 chose “Stay boundary”')).toBeInTheDocument();
    expect(teach.getByRole('link', { name: 'Open the play in Motion Lab' })).toHaveAttribute('href', '/motion-lab/plays/14');
    fireEvent.click(teach.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('TEACH offers the Motion Lab play only to a coach who can open Motion Lab', async () => {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 2, is_platform_owner: false } } as never);
    open();
    const card = within(await screen.findByRole('article', { name: 'Motion adjustment' }));
    fireEvent.click(card.getByRole('button', { name: 'Teach' }));
    const teach = within(screen.getByRole('dialog', { name: 'Teach Motion adjustment' }));
    expect(teach.getByText('Rotate down')).toBeInTheDocument();
    expect(teach.queryByRole('link', { name: 'Open the play in Motion Lab' })).toBeNull();
  });

  it('RETEST sends that concept straight back to the players who missed it and opens the new rep', async () => {
    open();
    const card = within(await screen.findByRole('article', { name: 'Motion adjustment' }));
    fireEvent.click(card.getByRole('button', { name: 'Retest' }));
    expect(card.getByText(/back to the 2 players who missed it/)).toBeInTheDocument();
    fireEvent.click(card.getByRole('button', { name: 'Send retest' }));
    await waitFor(() => expect(screen.getByText("the retest's page")).toBeInTheDocument());
    expect(repsApi.createRepRetest).toHaveBeenCalledWith(5, 3);
    expect(codesApi.activateQuiz).toHaveBeenCalledWith(6, [], 'PRACTICE');
  });

  it('a retest answers "did it stick?": how many missed before, how many still miss now', async () => {
    open({
      ...RESULTS,
      title: 'Motion adjustment - Retest',
      concepts: [{ ...RESULTS.concepts[0], responded: 3, missed: 1 }],
      audience: { label: null, invited: 4, code: 'MYTH7W', people: [] },
      retest_of: {
        id: 5,
        title: 'Trips Jet - Boundary safety',
        concepts: [{ concept: { id: 3, name: 'Motion adjustment' }, name: 'Motion adjustment', missed_before: 4, responded_before: 11 }],
      },
    });
    const stick = within(await screen.findByRole('region', { name: 'Did it stick' }));
    expect(stick.getByRole('link', { name: 'Trips Jet - Boundary safety' })).toHaveAttribute('href', '/reps/5');
    expect(stick.getByText('4 missed before')).toBeInTheDocument();
    expect(stick.getByText('1 of 3 still missing')).toBeInTheDocument();
    expect(stick.getByText('1 to go')).toBeInTheDocument();
  });

  it("fixes who the player is right on the decision", async () => {
    vi.mocked(questionsApi.updateQuestion).mockResolvedValue({} as never);
    open();
    const role = await screen.findByRole('textbox', { name: 'Who the player is in decision 1' });
    expect(role).toHaveValue('Boundary safety');
    fireEvent.change(role, { target: { value: 'Field safety' } });
    fireEvent.blur(role);
    await waitFor(() => expect(questionsApi.updateQuestion).toHaveBeenCalledWith(5, 11, { subject_role: 'Field safety' }));
  });

  it('the next step is said: Teach first, then Retest - and Retest is right there in Teach', async () => {
    open();
    const card = within(await screen.findByRole('article', { name: 'Motion adjustment' }));
    // Before teaching, Teach leads.
    expect(card.getByRole('button', { name: 'Teach' }).className).toMatch(/btnPrimary/);
    fireEvent.click(card.getByRole('button', { name: 'Teach' }));
    const teach = within(screen.getByRole('dialog', { name: 'Teach Motion adjustment' }));
    fireEvent.click(teach.getByRole('button', { name: 'Close' }));
    // Taught: Retest leads, and the card says so.
    expect(card.getByText('Taught it. Now see if it stuck.')).toBeInTheDocument();
    expect(card.getByRole('button', { name: 'Retest' }).className).toMatch(/btnPrimary/);
    // And from the teaching screen, one tap sends it.
    fireEvent.click(card.getByRole('button', { name: 'Teach' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retest the 2 who missed' }));
    await waitFor(() => expect(screen.getByText("the retest's page")).toBeInTheDocument());
    expect(repsApi.createRepRetest).toHaveBeenCalledWith(5, 3);
    expect(codesApi.activateQuiz).toHaveBeenCalledWith(6, [], 'PRACTICE');
  });

  it('once retested, the card says how it went and opens the retest', async () => {
    const retest = { id: 6, title: 'Motion adjustment - Retest', invited: 4, ran: 3, responded: 3, missed: 1 };
    open({ ...RESULTS, concepts: [{ ...RESULTS.concepts[0], retest }, RESULTS.concepts[1]] });
    const card = within(await screen.findByRole('article', { name: 'Motion adjustment' }));
    expect(card.getByText(/Retest: 1 of 3 still missing\./)).toBeInTheDocument();
    expect(card.getByText(/1 to go/)).toBeInTheDocument();
    expect(card.getByRole('link', { name: 'Open retest' })).toHaveAttribute('href', '/reps/6');
    expect(card.queryByRole('button', { name: 'Retest' })).toBeNull();
  });

  it('a problem the retest fixed says so', async () => {
    const retest = { id: 6, title: 'Motion adjustment - Retest', invited: 4, ran: 4, responded: 4, missed: 0 };
    open({ ...RESULTS, concepts: [{ ...RESULTS.concepts[0], retest }, RESULTS.concepts[1]] });
    const card = within(await screen.findByRole('article', { name: 'Motion adjustment' }));
    expect(card.getByText('Fixed on the retest: all 4 got it.')).toBeInTheDocument();
  });

  it('a decision made from Motion Lab opens its play, for a coach who has Motion Lab', async () => {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: true } } as never);
    open();
    const decisions = within(await screen.findByRole('region', { name: 'Decisions' }));
    expect(decisions.getByRole('link', { name: 'Open the play' })).toHaveAttribute('href', '/motion-lab/plays/14');
  });

  it('a rep not yet sent offers the groups and sends it, always for immediate feedback', async () => {
    open({ ...RESULTS, players: [], concepts: [], audience: { label: null, invited: 0, code: null, people: [] } });
    expect(await screen.findByText(/No one has run it yet/)).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Safeties/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send rep' }));
    await waitFor(() => expect(codesApi.activateQuiz).toHaveBeenCalledWith(5, [9], 'PRACTICE'));
    expect(repsApi.getRepResults).toHaveBeenCalledTimes(2);
  });
});
