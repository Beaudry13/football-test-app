import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/installs', () => ({ listInstalls: vi.fn(), createInstall: vi.fn(), updateInstall: vi.fn(), installsFor: vi.fn(), addToInstall: vi.fn() }));
vi.mock('../../api/players', () => ({ listPlayers: vi.fn() }));
import * as installsApi from '../../api/installs';
import * as playersApi from '../../api/players';
import type { InstallSummary } from '../../api/installs';
import type { Player } from '../../api/types';
import { AddToInstall } from './AddToInstall';
import { InstallsPage } from './InstallsPage';
import { contents, itemDetail, kindLabel } from './installDetail';

/**
 * INSTALLS: what he is installing, this week's first; old weeks archived out
 * of the way. A new one is a name and, for a position room, who it is for.
 */

const summary = (id: number, title: string, over: Partial<InstallSummary> = {}): InstallSummary => ({
  id,
  title,
  position_group: null,
  archived: false,
  item_count: 3,
  counts: { plays: 1, quizzes: 1, reps: 1, concepts: 0 },
  created_at: '',
  updated_at: '',
  ...over,
});

let landed = '';
function Where() {
  landed = useLocation().pathname;
  return null;
}
function open() {
  render(
    <MemoryRouter initialEntries={['/installs']}>
      <Where />
      <Routes>
        <Route path="/installs" element={<InstallsPage />} />
        <Route path="/installs/:id" element={<p>an install</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  landed = '';
  vi.mocked(playersApi.listPlayers).mockResolvedValue([]);
  vi.mocked(installsApi.listInstalls).mockImplementation(async (archived?: boolean) =>
    archived ? [summary(3, 'Week 6 - Baylor', { archived: true })] : [summary(1, 'Week 7 - West Virginia'), summary(2, 'Spring install 4', { item_count: 0, counts: { plays: 0, quizzes: 0, reps: 0, concepts: 0 } })],
  );
});

describe('Installs', () => {
  it("this week's first, each one tap from teaching it; an empty one has nothing to teach", async () => {
    open();
    const list = await screen.findAllByRole('listitem');
    expect(within(list[0]).getByRole('link', { name: 'Week 7 - West Virginia' })).toHaveAttribute('href', '/installs/1');
    expect(within(list[0]).getByText(/This week/)).toBeInTheDocument();
    expect(within(list[0]).getByText(/1 play · 1 Rep · 1 quiz/)).toBeInTheDocument();
    expect(within(list[0]).getByRole('link', { name: 'Teach' })).toHaveAttribute('href', '/installs/1?teach=1');
    expect(within(list[1]).getByText(/Nothing in it yet/)).toBeInTheDocument();
    expect(within(list[1]).queryByRole('link', { name: 'Teach' })).toBeNull();
  });

  it('a new install is a name - and, for a position room, who it is for - then it opens', async () => {
    vi.mocked(playersApi.listPlayers).mockResolvedValue([{ id: 1, position: 'FS', is_active: true } as Player, { id: 2, position: 'SS', is_active: true } as Player]);
    vi.mocked(installsApi.createInstall).mockResolvedValue({ id: 9, title: 'Safeties - Week 7' } as never);
    open();
    fireEvent.change(await screen.findByRole('textbox', { name: 'New install name' }), { target: { value: 'Safeties - Week 7' } });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Who it is for' }), { target: { value: 'family:Safeties' } });
    fireEvent.click(screen.getByRole('button', { name: 'New install' }));
    await waitFor(() => expect(installsApi.createInstall).toHaveBeenCalledWith({ title: 'Safeties - Week 7', position_group: 'family:Safeties' }));
    await waitFor(() => expect(landed).toBe('/installs/9'));
  });

  it('archived weeks stay out of the way until asked for, and come back with Restore', async () => {
    vi.mocked(installsApi.updateInstall).mockResolvedValue({} as never);
    open();
    const toggle = await screen.findByRole('button', { name: 'Archived (1)' });
    expect(screen.queryByText('Week 6 - Baylor')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByRole('link', { name: 'Week 6 - Baylor' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(installsApi.updateInstall).toHaveBeenCalledWith(3, { archived: false }));
  });
});

describe('Add to install, from where the football is', () => {
  it('opens on his installs, adds with one tap, and starts a new one right there', async () => {
    vi.mocked(installsApi.installsFor).mockResolvedValue([{ id: 1, title: 'Week 7 - West Virginia', has: false }]);
    vi.mocked(installsApi.addToInstall).mockResolvedValue({} as never);
    vi.mocked(installsApi.createInstall).mockResolvedValue({ id: 2, title: 'Safeties - Week 7' } as never);
    render(
      <MemoryRouter>
        <AddToInstall kind="concept" refId={5} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to install' }));
    const panel = within(screen.getByRole('dialog', { name: 'Add to install' }));
    expect(installsApi.installsFor).toHaveBeenCalledWith('concept', 5);
    fireEvent.click(await panel.findByRole('button', { name: 'Add' }));
    await waitFor(() => expect(installsApi.addToInstall).toHaveBeenCalledWith(1, 'concept', 5));
    expect(await panel.findByRole('link', { name: '✓ In it' })).toHaveAttribute('href', '/installs/1');

    fireEvent.change(panel.getByRole('textbox', { name: 'New install name' }), { target: { value: 'Safeties - Week 7' } });
    fireEvent.click(panel.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(installsApi.addToInstall).toHaveBeenCalledWith(2, 'concept', 5));
    expect(installsApi.createInstall).toHaveBeenCalledWith({ title: 'Safeties - Week 7' });
    expect(await panel.findAllByRole('link', { name: '✓ In it' })).toHaveLength(2);

    // Escape puts it away.
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Add to install' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Add to install' })).toBeNull();
  });
});

describe('What PEIRA already knows, in one line', () => {
  it('says only what it knows - made, out, turned in, to grade, still missing - nothing scored', () => {
    const quiz = { id: 1, kind: 'quiz', section_id: null, position: 0, ref_id: 30, ref: { id: 30, title: 'Q', kind: 'QUIZ', question_count: 6 } } as const;
    expect(kindLabel({ ...quiz, status: { live: false, submitted: 0, to_grade: 0, weakest: null } })).toBe('Quiz');
    expect(itemDetail({ ...quiz, status: { live: false, submitted: 0, to_grade: 0, weakest: null } })).toEqual({ parts: ['6 questions'], attention: null });
    expect(
      itemDetail({ ...quiz, status: { live: true, submitted: 8, to_grade: 3, weakest: { concept_id: 5, name: 'Motion adjustment', missed: 4, responded: 8 } } }),
    ).toEqual({ parts: ['Out now', '8 turned in'], attention: '3 to grade · Weakest: Motion adjustment (4 of 8)' });

    const rep = { ...quiz, ref: { id: 5, title: 'R', kind: 'REP' as const, question_count: 1 } };
    expect(kindLabel({ ...rep, status: { live: false, ran: 0, invited: 0, open_problem: null } })).toBe('Rep');
    expect(itemDetail({ ...rep, status: { live: false, ran: 0, invited: 0, open_problem: null } })).toEqual({ parts: ['1 decision'], attention: null });
    expect(
      itemDetail({ ...rep, status: { live: false, ran: 4, invited: 11, open_problem: { name: 'Leverage', concept_id: 4, missed: 3, responded: 4, taught: true } } }),
    ).toEqual({ parts: ['4 of 11 ran it'], attention: 'Leverage: 3 of 4 missed · taught' });

    const play = { id: 2, kind: 'play', section_id: null, position: 0, ref_id: 14, ref: { id: 14, name: 'Trips Jet', updated_at: '' } } as const;
    expect(itemDetail({ ...play, status: { made: { quizzes: 0, reps: 0 } } }).parts).toEqual(['Nothing made from it yet']);
    expect(itemDetail({ ...play, status: { made: { quizzes: 2, reps: 1 } } }).parts).toEqual(['1 Rep · 2 quizzes made from it']);

    const concept = { id: 3, kind: 'concept', section_id: null, position: 0, ref_id: 5, ref: { id: 5, name: 'Motion adjustment', is_archived: false }, status: { in: { quizzes: 0, reps: 0 } } } as const;
    expect(itemDetail(concept)).toEqual({ parts: ['Not in any quiz or Rep yet'], attention: null });
    const need = { concept_id: 5, name: 'Motion adjustment', got: 1, missing: [{ player_id: 1, name: 'A', last: {} as never }, { player_id: 2, name: 'B', last: {} as never }] };
    expect(itemDetail(concept, { need, players: 3, plural: 'safeties' }).attention).toBe('2 of 3 safeties still missing it');
    expect(itemDetail(concept, { need: { ...need, missing: [] }, players: 3, plural: 'safeties' }).attention).toBeNull();

    expect(contents({ item_count: 0, counts: { plays: 0, quizzes: 0, reps: 0, concepts: 0 } })).toBe('Nothing in it yet');
    expect(contents({ item_count: 4, counts: { plays: 2, quizzes: 0, reps: 1, concepts: 1 } })).toBe('2 plays · 1 Rep · 1 concept');
  });
});
