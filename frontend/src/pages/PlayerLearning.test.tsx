import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as playersApi from '../api/players';
import * as repsApi from '../api/reps';
import type { LearningEvent, PlayerLearning as Learning } from '../api/players';
import { PlayerLearning } from './PlayerLearning';

const event = (over: Partial<LearningEvent> = {}): LearningEvent => ({
  concept_id: 1,
  outcome: 'missed',
  question_ids: [41],
  at: '2026-10-10T10:00:00Z',
  quiz_id: 7,
  quiz_title: 'Week 6 coverage',
  kind: 'QUIZ',
  is_retest: false,
  ...over,
});

const learning = (over: Partial<Learning> = {}): Learning => ({
  has: [{ concept_id: 2, name: 'Leverage', last: event({ concept_id: 2, outcome: 'got' }) }],
  work_on: [{ concept_id: 1, name: 'Motion adjustment', last: event() }],
  recent: [
    {
      concept_id: 3,
      name: 'Cover 3 rotation',
      trail: [event({ concept_id: 3 }), event({ concept_id: 3, outcome: 'got', is_retest: true })],
    },
  ],
  ...over,
});

function renderPanel() {
  return render(
    <MemoryRouter initialEntries={['/roster/5']}>
      <Routes>
        <Route path="/roster/5" element={<PlayerLearning playerId={5} firstName="Bo" />} />
        <Route path="/reps/:id" element={<p>rep page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('What a player knows', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says what he has, what to work on, and how a concept changed', async () => {
    vi.spyOn(playersApi, 'getPlayerLearning').mockResolvedValue(learning());
    renderPanel();
    expect(await screen.findByRole('heading', { name: 'What Bo knows' })).toBeInTheDocument();
    expect(screen.getByText('Leverage')).toBeInTheDocument();
    expect(screen.getByText('Motion adjustment')).toBeInTheDocument();
    expect(screen.getByText('Missed in Week 6 coverage')).toBeInTheDocument();
    // A quiz miss is taught from the quiz's Results.
    expect(screen.getByRole('link', { name: 'Teach' })).toHaveAttribute('href', '/quizzes/7?tab=results');
    // How each concept changed is one level down, folded.
    expect(screen.getByText('Retest correct').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('How it changed')).toBeInTheDocument();
  });

  it('teaches a Rep miss straight in Teach', async () => {
    vi.spyOn(playersApi, 'getPlayerLearning').mockResolvedValue(
      learning({ work_on: [{ concept_id: 1, name: 'Motion adjustment', last: event({ kind: 'REP', quiz_id: 9 }) }] }),
    );
    renderPanel();
    expect(await screen.findByRole('link', { name: 'Teach' })).toHaveAttribute('href', '/reps/9?teach=1');
  });

  it('retests just this player on the decisions he missed - built, not sent', async () => {
    vi.spyOn(playersApi, 'getPlayerLearning').mockResolvedValue(learning());
    const make = vi.spyOn(repsApi, 'makeRepFromQuiz').mockResolvedValue({ id: 33 } as repsApi.RepFromQuiz);
    const roster = vi.spyOn(playersApi, 'addRosterMembers').mockResolvedValue({} as never);
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Retest Bo' }));
    expect(make).toHaveBeenCalledWith(7, [41], 'Motion adjustment - Bo');
    expect(roster).toHaveBeenCalledWith(33, [5]);
    expect(await screen.findByText('rep page')).toBeInTheDocument();
  });

  it('stays out of the way when there is nothing tagged yet, or it fails', async () => {
    const spy = vi
      .spyOn(playersApi, 'getPlayerLearning')
      .mockResolvedValue(learning({ has: [], work_on: [], recent: [] }));
    const { container, unmount } = renderPanel();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    spy.mockRejectedValue(new Error('down'));
    const again = renderPanel();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(again.container).toBeEmptyDOMElement();
  });
});
