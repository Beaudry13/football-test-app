import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/reps', () => ({ getRepResults: vi.fn(), createRepRetest: vi.fn() }));
vi.mock('../../api/accessCodes', () => ({ activateQuiz: vi.fn() }));
vi.mock('../../api/groups', () => ({ listGroups: vi.fn() }));
vi.mock('../../api/questions', () => ({ updateQuestion: vi.fn(), reorderQuestions: vi.fn(), deleteQuestion: vi.fn() }));
vi.mock('../../api/concepts', () => ({ listConcepts: vi.fn(), createConcept: vi.fn() }));
vi.mock('../../api/players', () => ({ listPlayers: vi.fn() }));
vi.mock('../../api/roster', () => ({ addRosterMembers: vi.fn() }));
import * as repsApi from '../../api/reps';
import * as codesApi from '../../api/accessCodes';
import * as groupsApi from '../../api/groups';
import * as questionsApi from '../../api/questions';
import * as conceptsApi from '../../api/concepts';
import * as playersApi from '../../api/players';
import * as rosterApi from '../../api/roster';
import * as quizzesApi from '../../api/quizzes';
import userEvent from '@testing-library/user-event';
import { acceptConfirm } from '../../test/confirmDialog';
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

function open(results: RepResults = RESULTS, at = '/reps/5') {
  vi.mocked(repsApi.getRepResults).mockResolvedValue(results);
  render(
    <MemoryRouter initialEntries={[at]}>
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
  vi.mocked(playersApi.listPlayers).mockResolvedValue([]);
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

  it("arrives straight in Teach from Home's \"Teach it\"", async () => {
    open(RESULTS, '/reps/5?teach=3');
    expect(await screen.findByRole('dialog', { name: 'Teach Motion adjustment' })).toBeInTheDocument();
  });

  it('edits a decision right on the page: situation, answers, the right one, concept, reason', async () => {
    vi.mocked(conceptsApi.listConcepts).mockResolvedValue([{ id: 3, name: 'Motion adjustment', is_archived: false }]);
    vi.mocked(questionsApi.updateQuestion).mockResolvedValue({} as never);
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit decision 1' }));
    const editor = within(screen.getByRole('group', { name: 'Edit decision 1' }));
    fireEvent.change(editor.getByRole('textbox', { name: 'The situation' }), { target: { value: '#3 motions across. Your check?' } });
    fireEvent.change(editor.getByRole('textbox', { name: 'Answer 3' }), { target: { value: 'Bail to the deep half' } });
    fireEvent.click(editor.getByRole('radio', { name: 'Answer 2 is the right one' }));
    fireEvent.change(editor.getByRole('textbox', { name: 'Concept' }), { target: { value: 'motion-adjustment' } });
    fireEvent.change(editor.getByRole('textbox', { name: 'Why' }), { target: { value: 'Stay over the top.' } });
    await waitFor(() => expect(conceptsApi.listConcepts).toHaveBeenCalled());
    fireEvent.click(editor.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(questionsApi.updateQuestion).toHaveBeenCalled());
    expect(questionsApi.updateQuestion).toHaveBeenCalledWith(5, 11, {
      question_text: '#3 motions across. Your check?',
      options: [
        { option_text: 'Rotate down', is_correct_answer: false },
        { option_text: 'Stay boundary', is_correct_answer: true },
        { option_text: 'Bail to the deep half', is_correct_answer: false },
      ],
      concept_id: 3,
      answer_explanation: 'Stay over the top.',
    });
    expect(conceptsApi.createConcept).not.toHaveBeenCalled();
    await waitFor(() => expect(repsApi.getRepResults).toHaveBeenCalledTimes(2));
  });

  it('once players have a decision, its right answer is locked and its answers cannot be removed', async () => {
    vi.mocked(conceptsApi.listConcepts).mockResolvedValue([]);
    open({ ...RESULTS, decisions: [{ ...RESULTS.decisions[0], delivered: true }] });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit decision 1' }));
    const editor = within(screen.getByRole('group', { name: 'Edit decision 1' }));
    expect(editor.getByText(/the right answer is locked/)).toBeInTheDocument();
    expect(editor.getByRole('radio', { name: 'Answer 1 is the right one' })).toBeDisabled();
    expect(editor.queryByRole('button', { name: 'Remove answer 1' })).toBeNull();
    // A new wrong answer can still be added.
    fireEvent.click(editor.getByRole('button', { name: '+ Answer' }));
    expect(editor.getByRole('textbox', { name: 'Answer 4' })).toBeInTheDocument();
  });

  it('moves a decision up or down - the order players meet them in', async () => {
    vi.mocked(questionsApi.reorderQuestions).mockResolvedValue([] as never);
    const second = { ...RESULTS.decisions[0], question_id: 12, number: 2, question_text: 'Who has #3 on the seam?' };
    open({ ...RESULTS, decisions: [RESULTS.decisions[0], second] });
    expect(await screen.findByRole('button', { name: 'Move decision 1 up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move decision 1 down' }));
    await waitFor(() => expect(questionsApi.reorderQuestions).toHaveBeenCalledWith(5, [12, 11]));
    await waitFor(() => expect(repsApi.getRepResults).toHaveBeenCalledTimes(2));
  });

  it('drags a decision by its grip to where it goes', async () => {
    vi.mocked(questionsApi.reorderQuestions).mockResolvedValue([] as never);
    const d = (id: number, number: number) => ({ ...RESULTS.decisions[0], question_id: id, number });
    open({ ...RESULTS, decisions: [d(11, 1), d(12, 2), d(13, 3)] });
    const decisions = within(await screen.findByRole('region', { name: 'Decisions' }));
    const rows = decisions.getAllByRole('listitem').filter((li) => li.getAttribute('draggable') !== null);
    // Rows are not draggable until the grip is taken, so typing never drags.
    expect(rows[2]).toHaveAttribute('draggable', 'false');
    fireEvent.pointerDown(screen.getByTestId('grip-3'));
    expect(rows[2]).toHaveAttribute('draggable', 'true');
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(rows[2], { dataTransfer });
    fireEvent.dragOver(rows[0], { dataTransfer });
    fireEvent.drop(rows[0], { dataTransfer });
    await waitFor(() => expect(questionsApi.reorderQuestions).toHaveBeenCalledWith(5, [13, 11, 12]));
  });

  it('a decision made from Motion Lab opens its play, for a coach who has Motion Lab', async () => {
    vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: true } } as never);
    open();
    const decisions = within(await screen.findByRole('region', { name: 'Decisions' }));
    expect(decisions.getByRole('link', { name: 'Open the play' })).toHaveAttribute('href', '/motion-lab/plays/14');
  });

  it('offers the roster by position, picks the one its roles point at, and sends to them', async () => {
    vi.mocked(playersApi.listPlayers).mockResolvedValue([
      { id: 21, position: 'S', is_active: true },
      { id: 22, position: 'FS', is_active: true },
      { id: 31, position: 'CB', is_active: true },
    ] as never);
    vi.mocked(rosterApi.addRosterMembers).mockResolvedValue({} as never);
    open({ ...RESULTS, players: [], concepts: [], audience: { label: null, invited: 0, code: null, people: [] } });
    const positions = within(await screen.findByRole('group', { name: 'Positions' }));
    const safeties = await positions.findByRole('button', { name: /Safeties/ });
    expect(safeties).toHaveAttribute('aria-pressed', 'true');
    expect(safeties.textContent).toMatch(/FS, S · 2\s*suggested/);
    expect(positions.getByRole('button', { name: /Corners/ })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Send rep' }));
    await waitFor(() => expect(codesApi.activateQuiz).toHaveBeenCalledWith(5, [], 'PRACTICE'));
    expect(rosterApi.addRosterMembers).toHaveBeenCalledWith(5, [21, 22]);
  });

  it('a rep sent to one position family says them by name', async () => {
    open({ ...RESULTS, audience: { label: null, invited: 11, code: 'KKFFQY', people: [], positions: ['FS', 'S'] } });
    const card = within(await screen.findByRole('article', { name: 'Motion adjustment' }));
    expect(card.getByText(/safeties missed/)).toBeInTheDocument();
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

describe('a variation of a Rep', () => {
  it('copies the rep, names it a variation and opens it - with nothing sent', async () => {
    const copy: RepResults = {
      ...RESULTS,
      quiz_id: 31,
      title: 'Trips Jet - Boundary safety - variation',
      players: [],
      audience: { label: null, invited: 0, code: null, people: [] },
    };
    vi.mocked(repsApi.getRepResults).mockImplementation(async (id: number) => (id === 31 ? copy : RESULTS));
    const duplicate = vi.spyOn(quizzesApi, 'duplicateQuiz').mockResolvedValue({ id: 31 } as never);
    const rename = vi.spyOn(quizzesApi, 'updateQuiz').mockResolvedValue({} as never);
    render(
      <MemoryRouter initialEntries={['/reps/5']}>
        <Routes>
          <Route path="/reps/:quizId" element={<RepPage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Make a variation' }));
    await waitFor(() => expect(duplicate).toHaveBeenCalledWith(5));
    expect(rename).toHaveBeenCalledWith(31, { title: 'Trips Jet - Boundary safety - variation' });
    const banner = await screen.findByRole('region', { name: 'Variation' });
    expect(banner).toHaveTextContent('nothing sent yet');
    expect(within(banner).getByRole('link', { name: 'the original rep' })).toHaveAttribute('href', '/reps/5');
    // Ready to send, never sent.
    expect(screen.getByRole('button', { name: 'Send rep' })).toBeInTheDocument();
    expect(codesApi.activateQuiz).not.toHaveBeenCalled();
    // A variation does not offer to vary itself while its banner is up.
    expect(screen.queryByRole('button', { name: 'Make a variation' })).toBeNull();
  });

  it('names it right there', async () => {
    const copy: RepResults = { ...RESULTS, quiz_id: 31, title: 'Copy', audience: { label: null, invited: 0, code: null, people: [] } };
    const rename = vi.spyOn(quizzesApi, 'updateQuiz').mockResolvedValue({} as never);
    open(copy, '/reps/31?variation=5');
    const name = await screen.findByRole('textbox', { name: 'Variation name' });
    fireEvent.change(name, { target: { value: 'Trips Jet - Corner' } });
    fireEvent.blur(name);
    await waitFor(() => expect(rename).toHaveBeenCalledWith(31, { title: 'Trips Jet - Corner' }));
  });

  it('a decision nobody has received can be removed; one a player has cannot', async () => {
    const user = userEvent.setup();
    const two: RepResults = {
      ...RESULTS,
      decisions: [
        { ...RESULTS.decisions[0], delivered: true },
        { ...RESULTS.decisions[0], question_id: 12, number: 2, delivered: false },
      ],
    };
    vi.mocked(questionsApi.deleteQuestion).mockResolvedValue(undefined);
    open(two);
    await screen.findByRole('button', { name: 'Remove decision 2' });
    expect(screen.queryByRole('button', { name: 'Remove decision 1' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove decision 2' }));
    await acceptConfirm(user, 'Remove');
    await waitFor(() => expect(questionsApi.deleteQuestion).toHaveBeenCalledWith(5, 12));
  });
});
