import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/reps', () => ({
  getRepResults: vi.fn(),
  getMadeFromPlay: vi.fn(),
  createRepRetest: vi.fn(),
  makeRepFromQuiz: vi.fn(),
  addDecisions: vi.fn(),
}));
vi.mock('../../api/quizzes', () => ({ getQuiz: vi.fn() }));
vi.mock('../../api/grading', () => ({ getQuizDashboard: vi.fn() }));
vi.mock('../../api/retests', () => ({ createRetest: vi.fn() }));
vi.mock('../../api/accessCodes', () => ({ activateQuiz: vi.fn() }));
vi.mock('../../api/concepts', () => ({ getConceptFootball: vi.fn() }));
vi.mock('../../api/roster', () => ({ addRosterMembers: vi.fn() }));
vi.mock('../../api/motionLab', () => ({ getMotionPlay: vi.fn() }));
vi.mock('../../motion-lab/motionLabAccess', () => ({ useMayUseMotionLab: vi.fn(() => false) }));
// jsdom cannot draw; the picture itself is playImage's business.
vi.mock('../../motion-lab/playImage', () => ({ IMAGE_WIDTH: 1376, IMAGE_HEIGHT: 720, drawPlay: vi.fn() }));
import * as repsApi from '../../api/reps';
import * as quizzesApi from '../../api/quizzes';
import * as gradingApi from '../../api/grading';
import * as retestsApi from '../../api/retests';
import * as codesApi from '../../api/accessCodes';
import * as conceptsApi from '../../api/concepts';
import * as rosterApi from '../../api/roster';
import * as motionApi from '../../api/motionLab';
import * as access from '../../motion-lab/motionLabAccess';
import type { Install, InstallItem } from '../../api/installs';
import type { GroupNeeds } from '../../api/players';
import type { RepResults } from '../../api/reps';
import { toDocument } from '../../motion-lab/storage/apiPlayRepository';
import { gapPlays } from '../../motion-lab/__characterization__/fixtures';
import { InstallMeeting } from './InstallMeeting';

/**
 * TEACH THE INSTALL: one Teach screen walking the install in order - Next is
 * the next piece of football, not a trip back to the list. An item with
 * nothing to show is passed over; Ask first, the room and Retest work on
 * every item exactly as they do everywhere else.
 */

const q = (id: number, text: string, conceptId = 5) => ({
  id,
  question_text: text,
  question_type: 'multiple_choice',
  concept: { id: conceptId, name: 'Motion adjustment', is_archived: false },
  image: { id, image_url: `/uploads/${id}.png` },
  options: [
    { id: id * 10, option_text: 'Rotate down', is_correct_answer: true },
    { id: id * 10 + 1, option_text: 'Stay', is_correct_answer: false },
  ],
  answer_explanation: `Why ${id}`,
  is_retired: false,
});
const QUIZZES: Record<number, unknown> = {
  30: { id: 30, title: 'Boundary safety', kind: 'QUIZ', questions: [q(70, 'Rotate or stay?'), q(71, 'Who is #3 now?')] },
  31: { id: 31, title: 'Red zone', kind: 'QUIZ', questions: [q(81, 'Deep third?', 6)] },
};

const person = (key: string, display_name: string) => ({ key, player_id: null, display_name, position: 'S', jersey_number: null });
const REP: RepResults = {
  quiz_id: 5,
  title: 'Trips Jet - Boundary safety',
  players: [],
  decisions: [
    {
      question_id: 11,
      number: 1,
      question_text: '#3 motions across. What is your check?',
      question_type: 'multiple_choice',
      subject_role: 'Boundary safety',
      concept: { id: 3, name: 'Motion adjustment' },
      motion_play_id: null,
      answer_explanation: 'He is the new #3 - rotate down.',
      image: null,
      is_retired: false,
      correct_text: ['Rotate down'],
      responded: 5,
      missed: 2,
      median_ms: 4200,
      choices: [],
      answers: [],
    },
  ],
  concepts: [
    {
      concept: { id: 3, name: 'Motion adjustment' },
      name: 'Motion adjustment',
      responded: 5,
      missed: 2,
      players_missed: [
        { ...person('p1', 'Marcus Hill'), answers: [] },
        { ...person('p3', 'Caleb Reed'), answers: [] },
      ],
      most_common_wrong: null,
      question_ids: [11],
      motion_play_id: null,
    },
  ],
  audience: { label: 'Safeties', invited: 5, code: null, people: [] },
  retest_of: null,
};

const item = (id: number, position: number, rest: Record<string, unknown>) => ({ id, section_id: null, position, ...rest }) as unknown as InstallItem;
const quizItem = (id: number, position: number, quizId: number, title: string) =>
  item(id, position, { kind: 'quiz', ref_id: quizId, ref: { id: quizId, title, kind: 'QUIZ', question_count: 2 }, status: {} });
const repItem = (id: number, position: number) =>
  item(id, position, { kind: 'quiz', ref_id: 5, ref: { id: 5, title: REP.title, kind: 'REP', question_count: 1 }, status: {} });
const conceptItem = (id: number, position: number, conceptId: number, name: string) =>
  item(id, position, { kind: 'concept', ref_id: conceptId, ref: { id: conceptId, name, is_archived: false }, status: {} });
const playItem = (id: number, position: number, playId: number, name: string) =>
  item(id, position, { kind: 'play', ref_id: playId, ref: { id: playId, name, updated_at: '' }, status: {} });

const install = (items: InstallItem[], over: Partial<Install> = {}): Install => ({
  id: 1,
  title: 'Week 7 - West Virginia',
  position_group: null,
  archived: false,
  current: false,
  item_count: items.length,
  counts: { plays: 0, quizzes: 0, reps: 0, concepts: 0 },
  created_at: '',
  updated_at: '',
  sections: [],
  items,
  ...over,
});

let landed = '';
let landedState: unknown = null;
function Where() {
  landed = useLocation().pathname + useLocation().search;
  landedState = useLocation().state;
  return null;
}

function meet(of: Install, groupNeeds: GroupNeeds | null = null, groupLabel: string | null = null) {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/installs/1']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <Where />
              <InstallMeeting install={of} groupNeeds={() => Promise.resolve(groupNeeds)} groupLabel={groupLabel} onClose={onClose} />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}
const screenOf = async (title: string) => within(await screen.findByRole('dialog', { name: `Teach ${title}` }));

beforeEach(() => {
  vi.clearAllMocks();
  landed = '';
  vi.mocked(access.useMayUseMotionLab).mockReturnValue(false);
  vi.mocked(quizzesApi.getQuiz).mockImplementation(async (id: number) => QUIZZES[id] as never);
  vi.mocked(gradingApi.getQuizDashboard).mockResolvedValue({ concept_breakdown: [], question_breakdown: [] } as never);
  vi.mocked(repsApi.getRepResults).mockResolvedValue(REP);
  // The one teach read: questions on the asked concept, from the asked quizzes (or all).
  vi.mocked(conceptsApi.getConceptFootball).mockImplementation(async (conceptId: number, ids: number[] = []) => {
    const asked = Object.values(QUIZZES as Record<number, { id: number; title: string; questions: { concept: { id: number } }[] }>).filter(
      (z) => ids.length === 0 || ids.includes(z.id),
    );
    return {
      quizzes: asked.map((z) => ({ id: z.id, title: z.title, kind: 'QUIZ', retest_of: null })),
      questions: asked.flatMap((z) => z.questions.filter((x) => x.concept.id === conceptId).map((x) => ({ ...x, quiz_id: z.id }))),
    } as never;
  });
});

describe('Teach install: one screen, item to item', () => {
  it('walks the install in order - Next is the next piece of football, an empty one passed over', async () => {
    meet(install([quizItem(101, 0, 30, 'Boundary safety'), repItem(102, 1), conceptItem(103, 2, 9, 'Leverage'), quizItem(104, 3, 31, 'Red zone')]));
    let teach = await screenOf('Boundary safety');
    expect(teach.getByText('Week 7 - West Virginia · 1 of 4')).toBeInTheDocument();
    expect(teach.getByText('Rotate or stay?')).toBeInTheDocument();
    // → steps the slides first; past the last one, the next item.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    expect(teach.getByText('Who is #3 now?')).toBeInTheDocument();
    fireEvent.click(teach.getByRole('button', { name: /Next: Trips Jet - Boundary safety/ }));

    teach = await screenOf('Trips Jet - Boundary safety');
    expect(teach.getByText('Week 7 - West Virginia · 2 of 4')).toBeInTheDocument();
    // The concept has no football of his yet: Next goes past it, to Red zone.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    teach = await screenOf('Red zone');
    expect(teach.getByText('Week 7 - West Virginia · 4 of 4')).toBeInTheDocument();
    expect(teach.queryByRole('button', { name: /^Next:/ })).toBeNull();
    // Back skips the empty item too.
    expect(teach.getByRole('button', { name: 'Back: Trips Jet - Boundary safety' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    await screenOf('Trips Jet - Boundary safety');
  });

  it('starts at the item he chose, and Ask first stays on from item to item', async () => {
    meet({ ...install([quizItem(101, 0, 30, 'Boundary safety'), quizItem(104, 1, 31, 'Red zone')]) }, null, null);
    const teach = await screenOf('Boundary safety');
    fireEvent.click(teach.getByRole('button', { name: 'Ask first' }));
    expect(teach.queryByText('Why 70')).toBeNull();
    fireEvent.click(teach.getByRole('button', { name: /Next: Red zone/ }));
    const next = await screenOf('Red zone');
    expect(next.getByRole('button', { name: 'Ask first' })).toHaveAttribute('aria-pressed', 'true');
    expect(next.queryByText('Why 81')).toBeNull();
  });

  it('an install with nothing to show closes instead of hanging', async () => {
    const onClose = meet(install([conceptItem(103, 0, 9, 'Leverage')]));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe('Check understanding and retest without leaving the meeting', () => {
  it('a Rep: its open problem, who missed it, and Retest the ones who missed - built and opened, not sent', async () => {
    vi.mocked(repsApi.createRepRetest).mockResolvedValue({ id: 77 } as never);
    meet(install([repItem(102, 0)]));
    const teach = await screenOf('Trips Jet - Boundary safety');
    expect(teach.getByText(/2 of 5 missed Motion adjustment/)).toBeInTheDocument();
    fireEvent.click(teach.getByRole('button', { name: 'Retest the 2' }));
    await waitFor(() => expect(landed).toBe('/reps/77'));
    expect(repsApi.createRepRetest).toHaveBeenCalledWith(5, 3);
    // The way back is this item of this meeting.
    expect(landedState).toEqual({ from: { to: '/installs/1?teach=1&at=0', label: 'Week 7 - West Virginia' } });
    // Opened ready to send: the coach presses Send rep on the new Rep itself.
    expect(codesApi.activateQuiz).not.toHaveBeenCalled();
  });

  it('a quiz: Retest its weakest concept for exactly who missed it', async () => {
    vi.mocked(gradingApi.getQuizDashboard).mockResolvedValue({
      question_breakdown: [],
      concept_breakdown: [
        {
          concept_id: 5,
          concept_name: 'Motion adjustment',
          player_miss_rate: 0.5,
          players_missed_count: 2,
          players_responded_count: 4,
          retestable_question_count: 2,
          players_missed: [
            { player_id: 1, player_name: 'ty', display_name: 'Ty X' },
            { player_id: null, player_name: 'walk-on', display_name: 'walk-on' },
          ],
        },
      ],
    } as never);
    vi.mocked(retestsApi.createRetest).mockResolvedValue({ id: 88 } as never);
    meet(install([quizItem(101, 0, 30, 'Boundary safety')]));
    const teach = await screenOf('Boundary safety');
    expect(teach.getByText(/2 of 4/)).toBeInTheDocument();
    fireEvent.click(teach.getByRole('button', { name: 'Retest the 2' }));
    await waitFor(() => expect(landed).toBe('/quizzes/88?tab=activate'));
    expect(retestsApi.createRetest).toHaveBeenCalledWith(30, { concept_id: 5, player_ids: [1], player_names: ['walk-on'] });
  });

  it("a position coach's install: the room's misses on a concept, and Retest them", async () => {
    vi.mocked(repsApi.makeRepFromQuiz).mockResolvedValue({ id: 99 } as never);
    vi.mocked(rosterApi.addRosterMembers).mockResolvedValue(undefined as never);
    const needs: GroupNeeds = {
      players: 3,
      concepts: [
        {
          concept_id: 5,
          name: 'Motion adjustment',
          got: 1,
          missing: [
            { player_id: 2, name: 'Bo X', last: { concept_id: 5, outcome: 'missed', question_ids: [70], at: '2026-10-21T10:00:00Z', quiz_id: 30, quiz_title: 'Boundary safety', kind: 'QUIZ', is_retest: false } },
            { player_id: 1, name: 'Ty X', last: { concept_id: 5, outcome: 'missed', question_ids: [71], at: '2026-10-20T10:00:00Z', quiz_id: 30, quiz_title: 'Boundary safety', kind: 'QUIZ', is_retest: false } },
          ],
        },
      ],
    } as GroupNeeds;
    meet(install([conceptItem(103, 0, 5, 'Motion adjustment')], { position_group: 'family:Safeties' }), needs, 'Safeties');
    const teach = await screenOf('Motion adjustment');
    expect(teach.getByText(/2 of 3/)).toBeInTheDocument();
    expect(teach.getByText('Rotate or stay?')).toBeInTheDocument();
    fireEvent.click(teach.getByRole('button', { name: 'Retest the 2' }));
    await waitFor(() => expect(landed).toBe('/reps/99'));
    expect(repsApi.makeRepFromQuiz).toHaveBeenCalledWith(30, [70, 71], 'Motion adjustment - Safeties');
    expect(rosterApi.addRosterMembers).toHaveBeenCalledWith(99, [2, 1]);
  });

  it('a play: the play as Motion Lab holds it, and Check them makes the check for the same man', async () => {
    vi.mocked(access.useMayUseMotionLab).mockReturnValue(true);
    const [a] = gapPlays();
    const man = a.players[0].id;
    vi.mocked(motionApi.getMotionPlay).mockResolvedValue({
      id: 14,
      name: a.name,
      document: toDocument(a),
      schema_version: 1,
      revision: 1,
      folder_id: null,
      copied_from_play_id: null,
      created_by_coach_id: 1,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
    });
    vi.mocked(repsApi.getMadeFromPlay).mockResolvedValue({
      made: [],
      last: { concept: { id: 3, name: 'Motion adjustment' }, subject_man: man, subject_role: 'Boundary safety', answer_explanation: 'He is the new #3 - rotate down.' },
    });
    meet(install([playItem(105, 0, 14, a.name)]));
    const teach = await screenOf(a.name);
    expect(teach.getAllByText('He is the new #3 - rotate down.').length).toBeGreaterThan(0);
    fireEvent.click(teach.getByRole('button', { name: /Check them/ }));
    fireEvent.click(within(teach.getByRole('menu', { name: 'Check them' })).getByRole('menuitem', { name: /Make a quiz question/ }));
    expect(landed).toBe(`/motion-lab/plays/14?make=question&man=${encodeURIComponent(man)}`);
  });

  it('plays stay out of the meeting for a coach without Motion Lab', async () => {
    meet(install([playItem(105, 0, 14, 'Trips Jet'), quizItem(101, 1, 30, 'Boundary safety')]));
    const teach = await screenOf('Boundary safety');
    expect(teach.getByText('Week 7 - West Virginia · 1 of 1')).toBeInTheDocument();
    expect(motionApi.getMotionPlay).not.toHaveBeenCalled();
  });
});
