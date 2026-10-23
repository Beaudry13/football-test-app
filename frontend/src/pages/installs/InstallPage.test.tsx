import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/installs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/installs')>();
  return {
    ...actual,
    getInstall: vi.fn(),
    addToInstall: vi.fn(),
    removeFromInstall: vi.fn(),
    setInstallLayout: vi.fn(),
    updateInstall: vi.fn(),
    duplicateInstall: vi.fn(),
    deleteInstall: vi.fn(),
  };
});
vi.mock('../../api/players', () => ({ listPlayers: vi.fn(), getGroupNeeds: vi.fn() }));
vi.mock('../../api/motionLab', () => ({ listMotionPlays: vi.fn(async () => []) }));
vi.mock('../../api/quizzes', () => ({ listQuizzes: vi.fn() }));
vi.mock('../../api/concepts', () => ({ listConcepts: vi.fn(async () => []) }));
vi.mock('../../motion-lab/motionLabAccess', () => ({ useMayUseMotionLab: () => true }));
// The meeting has its own tests; here, only where it opens.
vi.mock('./InstallMeeting', () => ({
  InstallMeeting: ({ startAt, install }: { startAt: number; install: { title: string } }) => (
    <div role="dialog" aria-label="Meeting">
      {install.title} from {startAt}
    </div>
  ),
}));
import * as installsApi from '../../api/installs';
import * as playersApi from '../../api/players';
import * as quizzesApi from '../../api/quizzes';
import type { Install, InstallItem, InstallLayout } from '../../api/installs';
import type { Player, Quiz } from '../../api/types';
import { InstallPage } from './InstallPage';

/**
 * AN INSTALL: the football he is installing, in the order he will teach it -
 * one primary action (Teach install), each row's own Teach, ↑ ↓ to order it
 * (touch-sized), one level of sections, and what PEIRA already knows beside
 * each piece. Nothing here copies football.
 */

const quizItem = (id: number, position: number, quizId: number, title: string, status: Record<string, unknown> = {}, sectionId: number | null = null) =>
  ({
    id,
    kind: 'quiz',
    section_id: sectionId,
    position,
    ref_id: quizId,
    ref: { id: quizId, title, kind: 'QUIZ', question_count: 6 },
    status: { live: false, submitted: 0, to_grade: 0, weakest: null, ...status },
  }) as InstallItem;
const repItem = (id: number, position: number) =>
  ({
    id,
    kind: 'quiz',
    section_id: null,
    position,
    ref_id: 5,
    ref: { id: 5, title: 'Trips Jet - Boundary safety', kind: 'REP', question_count: 2 },
    status: { live: true, ran: 4, invited: 11, open_problem: { name: 'Motion adjustment', concept_id: 3, missed: 3, responded: 4, taught: false } },
  }) as InstallItem;
const playItem = (id: number, position: number) =>
  ({ id, kind: 'play', section_id: null, position, ref_id: 14, ref: { id: 14, name: 'Trips Jet', updated_at: '' }, status: { made: { quizzes: 1, reps: 1 } } }) as InstallItem;
const conceptItem = (id: number, position: number) =>
  ({ id, kind: 'concept', section_id: null, position, ref_id: 5, ref: { id: 5, name: 'Motion adjustment', is_archived: false }, status: { in: { quizzes: 2, reps: 1 } } }) as InstallItem;

const INSTALL = (over: Partial<Install> = {}): Install => ({
  id: 1,
  title: 'Week 7 - West Virginia',
  position_group: null,
  archived: false,
  item_count: 3,
  counts: { plays: 1, quizzes: 1, reps: 1, concepts: 0 },
  created_at: '',
  updated_at: '',
  sections: [],
  items: [playItem(11, 0), repItem(12, 1), quizItem(13, 2, 30, 'Boundary safety', { to_grade: 3, submitted: 8 })],
  ...over,
});

const player = (id: number, position: string) => ({ id, first_name: `P${id}`, last_name: 'X', full_name: `P${id} X`, position, is_active: true }) as Player;

let landed = '';
function Where() {
  landed = useLocation().pathname;
  return null;
}

function open(install: Install = INSTALL(), at = '/installs/1') {
  vi.mocked(installsApi.getInstall).mockResolvedValue(install);
  render(
    <MemoryRouter initialEntries={[at]}>
      <Where />
      <Routes>
        <Route path="/installs/:installId" element={<InstallPage />} />
        <Route path="/installs" element={<p>all installs</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const rows = () => screen.getAllByRole('listitem').map((li) => within(li).getAllByRole('link')[0].textContent);

beforeEach(() => {
  vi.clearAllMocks();
  landed = '';
  vi.mocked(playersApi.listPlayers).mockResolvedValue([]);
  vi.mocked(installsApi.setInstallLayout).mockImplementation(async (_id: number, layout: InstallLayout) => {
    // The server's answer: the same items in the order asked for.
    const current = vi.mocked(installsApi.getInstall).mock.results[0].value as Promise<Install>;
    const base = await current;
    const byId = new Map(base.items.map((i) => [i.id, i]));
    const sections = layout.sections.map((s, position) => ({ id: s.id ?? 900 + position, title: s.title, position }));
    return {
      ...base,
      sections,
      items: [
        ...layout.loose.map((id, position) => ({ ...byId.get(id)!, section_id: null, position })),
        ...layout.sections.flatMap((s, si) => s.item_ids.map((id, position) => ({ ...byId.get(id)!, section_id: sections[si].id, position }))),
      ],
    } as Install;
  });
});

describe('An install: the football in teaching order', () => {
  it('lists each piece with its kind and what PEIRA already knows - the attention in its own words', async () => {
    open();
    expect(await screen.findByRole('heading', { name: 'Week 7 - West Virginia' })).toBeInTheDocument();
    expect(screen.getByText('1 play · 1 Rep · 1 quiz')).toBeInTheDocument();
    expect(rows()).toEqual(['Trips Jet', 'Trips Jet - Boundary safety', 'Boundary safety']);
    const [play, rep, quiz] = screen.getAllByRole('listitem');
    expect(within(play).getByText('Play')).toBeInTheDocument();
    expect(within(play).getByText(/1 Rep · 1 quiz made from it/)).toBeInTheDocument();
    expect(within(rep).getByText('Rep')).toBeInTheDocument();
    expect(within(rep).getByText(/Out now · 4 of 11 ran it/)).toBeInTheDocument();
    expect(within(rep).getByText(/Motion adjustment: 3 of 4 missed/)).toBeInTheDocument();
    expect(within(quiz).getByText(/3 to grade/)).toBeInTheDocument();
    // Each opens where it lives.
    expect(within(play).getByRole('link', { name: 'Trips Jet' })).toHaveAttribute('href', '/motion-lab/plays/14');
    expect(within(rep).getByRole('link', { name: 'Trips Jet - Boundary safety' })).toHaveAttribute('href', '/reps/5');
    expect(within(quiz).getByRole('link', { name: 'Boundary safety' })).toHaveAttribute('href', '/quizzes/30');
  });

  it('Teach install starts the meeting at the top; a row’s Teach starts it there', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Teach install' }));
    expect(screen.getByRole('dialog', { name: 'Meeting' })).toHaveTextContent('Week 7 - West Virginia from 0');
  });

  it('a row’s Teach starts the meeting at that row', async () => {
    open();
    await screen.findByRole('heading', { name: 'Week 7 - West Virginia' });
    fireEvent.click(within(screen.getAllByRole('listitem')[2]).getByRole('button', { name: 'Teach' }));
    expect(screen.getByRole('dialog', { name: 'Meeting' })).toHaveTextContent('from 2');
  });

  it('Home’s Teach (?teach=1) opens the meeting', async () => {
    open(INSTALL(), '/installs/1?teach=1');
    expect(await screen.findByRole('dialog', { name: 'Meeting' })).toHaveTextContent('from 0');
  });
});

describe('Putting it in order - arrows, on a phone too', () => {
  it('↓ moves a piece down, at once, and the server keeps the order', async () => {
    open();
    await screen.findByRole('heading', { name: 'Week 7 - West Virginia' });
    expect(screen.getByRole('button', { name: 'Move Trips Jet up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Boundary safety down' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move Trips Jet down' }));
    expect(rows()).toEqual(['Trips Jet - Boundary safety', 'Trips Jet', 'Boundary safety']);
    expect(installsApi.setInstallLayout).toHaveBeenCalledWith(1, { loose: [12, 11, 13], sections: [] });
    await waitFor(() => expect(rows()).toEqual(['Trips Jet - Boundary safety', 'Trips Jet', 'Boundary safety']));
  });

  it('one level of sections: add one, move football into it, take the section away and keep the football', async () => {
    open();
    await screen.findByRole('heading', { name: 'Week 7 - West Virginia' });
    fireEvent.click(screen.getByRole('button', { name: 'More for Week 7 - West Virginia' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add a section' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Section name' }), { target: { value: 'Third down' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add section' }));
    expect(installsApi.setInstallLayout).toHaveBeenLastCalledWith(1, { loose: [11, 12, 13], sections: [{ id: null, title: 'Third down', item_ids: [] }] });
    // The server's answer names the new section; until a piece is moved in, it says how.
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Third down' })).getByText(/Nothing here yet/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'More for Boundary safety' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Third down' }));
    expect(installsApi.setInstallLayout).toHaveBeenLastCalledWith(1, { loose: [11, 12], sections: [{ id: 900, title: 'Third down', item_ids: [13] }] });
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Third down' })).getByRole('link', { name: 'Boundary safety' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'More for Third down' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Remove the section/ }));
    expect(installsApi.setInstallLayout).toHaveBeenLastCalledWith(1, { loose: [11, 12, 13], sections: [] });
  });
});

describe('Adding and taking out - by reference', () => {
  it('Add football finds what he has; what is already in says so', async () => {
    vi.mocked(quizzesApi.listQuizzes).mockResolvedValue([
      { id: 30, title: 'Boundary safety', kind: 'QUIZ', question_count: 6, updated_at: '2026-10-20T00:00:00Z' },
      { id: 40, title: 'Cover 3 rules', kind: 'QUIZ', question_count: 4, updated_at: '2026-10-22T00:00:00Z' },
    ] as Quiz[]);
    vi.mocked(installsApi.addToInstall).mockResolvedValue(INSTALL({ items: [...INSTALL().items, quizItem(14, 3, 40, 'Cover 3 rules')] }));
    open();
    await screen.findByRole('heading', { name: 'Week 7 - West Virginia' });
    fireEvent.click(screen.getByRole('button', { name: 'Add football' }));
    const finder = within(screen.getByRole('region', { name: 'Add football' }));
    expect(await finder.findByText('Cover 3 rules')).toBeInTheDocument();
    expect(finder.getByText('✓ Added')).toBeInTheDocument();
    fireEvent.click(finder.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(installsApi.addToInstall).toHaveBeenCalledWith(1, 'quiz', 40));
    await waitFor(() => expect(finder.getAllByText('✓ Added')).toHaveLength(2));
    // Narrowed by a few letters.
    fireEvent.change(finder.getByRole('searchbox', { name: 'Find football' }), { target: { value: 'zzz' } });
    expect(finder.getByText('Nothing by that name.')).toBeInTheDocument();
  });

  it('Take out of the install leaves the football where it was', async () => {
    vi.mocked(installsApi.removeFromInstall).mockResolvedValue(INSTALL({ items: [playItem(11, 0), repItem(12, 1)] }));
    open();
    await screen.findByRole('heading', { name: 'Week 7 - West Virginia' });
    fireEvent.click(screen.getByRole('button', { name: 'More for Boundary safety' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Take out of the install' }));
    await waitFor(() => expect(installsApi.removeFromInstall).toHaveBeenCalledWith(1, 13));
    await waitFor(() => expect(rows()).toEqual(['Trips Jet', 'Trips Jet - Boundary safety']));
  });
});

describe('Next week, last week', () => {
  it('Duplicate for a new week copies the order and opens the copy', async () => {
    vi.mocked(installsApi.duplicateInstall).mockResolvedValue(INSTALL({ id: 2, title: 'Week 8 - Baylor' }));
    open();
    await screen.findByRole('heading', { name: 'Week 7 - West Virginia' });
    fireEvent.click(screen.getByRole('button', { name: 'More for Week 7 - West Virginia' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate for a new week' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New install name' }), { target: { value: 'Week 8 - Baylor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(installsApi.duplicateInstall).toHaveBeenCalledWith(1, 'Week 8 - Baylor'));
    await waitFor(() => expect(landed).toBe('/installs/2'));
  });

  it('Archive puts it away; Restore brings it back', async () => {
    vi.mocked(installsApi.updateInstall).mockResolvedValue(INSTALL({ archived: true }));
    open();
    await screen.findByRole('heading', { name: 'Week 7 - West Virginia' });
    fireEvent.click(screen.getByRole('button', { name: 'More for Week 7 - West Virginia' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() => expect(installsApi.updateInstall).toHaveBeenCalledWith(1, { archived: true }));
    expect(await screen.findByText('Install · archived')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More for Week 7 - West Virginia' }));
    expect(screen.getByRole('menuitem', { name: 'Restore' })).toBeInTheDocument();
  });
});

describe("A position coach's install", () => {
  it('is for a room - and a concept says how many of that room still miss it', async () => {
    vi.mocked(playersApi.listPlayers).mockResolvedValue([player(1, 'FS'), player(2, 'SS'), player(3, 'S'), player(4, 'CB')]);
    vi.mocked(playersApi.getGroupNeeds).mockResolvedValue({
      players: 3,
      concepts: [{ concept_id: 5, name: 'Motion adjustment', got: 1, missing: [{ player_id: 1, name: 'P1 X', last: {} }, { player_id: 2, name: 'P2 X', last: {} }] }],
    } as never);
    open(INSTALL({ title: 'Safeties - Week 7', position_group: 'family:Safeties', items: [conceptItem(15, 0)], counts: { plays: 0, quizzes: 0, reps: 0, concepts: 1 } }));
    expect(await screen.findByText('For Safeties')).toBeInTheDocument();
    expect(await screen.findByText(/2 of 3 safeties still missing it/)).toBeInTheDocument();
    await waitFor(() => expect(playersApi.getGroupNeeds).toHaveBeenCalledWith([1, 2, 3]));
  });

  it('who it is for is one choice', async () => {
    vi.mocked(playersApi.listPlayers).mockResolvedValue([player(1, 'FS'), player(4, 'CB')]);
    vi.mocked(installsApi.updateInstall).mockResolvedValue(INSTALL({ position_group: 'family:Corners' }));
    open();
    const pick = await screen.findByRole('combobox', { name: 'Who this install is for' });
    fireEvent.change(pick, { target: { value: 'family:Corners' } });
    await waitFor(() => expect(installsApi.updateInstall).toHaveBeenCalledWith(1, { position_group: 'family:Corners' }));
  });
});
