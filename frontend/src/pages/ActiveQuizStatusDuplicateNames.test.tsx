/** The live board, with two players called John Smith on it.
 *
 * One card is one list - Submitted, Started and Not started are read side by
 * side - so a John Smith in one column and a John Smith in another is exactly
 * the ambiguity the coach needs resolved. It is a LIVE board, so the label uses
 * live roster jersey and position.
 *
 * The keys were the other half: every list keyed its rows on the name, so two
 * same-named players in one column shared a React key.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveQuizStatusSection } from './ActiveQuizStatus';
import * as quizzesApi from '../api/quizzes';
import type { ActiveQuizStatus } from '../api/types';

const entry = (over: Partial<ActiveQuizStatus> = {}): ActiveQuizStatus => ({
  quiz_id: 1,
  quiz_title: 'Week 1 Prep',
  access_code_id: 10,
  code: 'ABC123',
  expires_at: new Date(Date.now() + 90 * 60000).toISOString(),
  group_names: [],
  roster_size: 3,
  mode: 'GRADED',
  is_practice: false,
  randomize_questions: false,
  submitted: [
    {
      player_name: 'John Smith',
      submitted_at: '2026-01-01T00:00:00Z',
      player_id: 21,
      jersey_number: '12',
      position: 'QB',
    },
  ],
  in_progress: [
    {
      player_name: 'Mike Beaudry',
      started_at: '2026-01-01T00:00:00Z',
      player_id: 30,
      jersey_number: '4',
      position: 'QB',
    },
  ],
  not_started: ['John Smith'],
  not_started_players: [
    { player_id: 22, player_name: 'John Smith', jersey_number: '37', position: 'LB' },
  ],
  ...over,
});

async function openCard(payload: ActiveQuizStatus) {
  vi.spyOn(quizzesApi, 'getActiveStatus').mockResolvedValue([payload]);
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <ActiveQuizStatusSection />
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: /Expand live status for Week 1 Prep/ }));
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

const duplicateKeyWarnings = () =>
  consoleError.mock.calls.filter((call: unknown[]) =>
    call.some((arg) => typeof arg === 'string' && /same key/i.test(arg)),
  );

describe('same-named players across the columns of one card', () => {
  it('are labelled with live jersey and position', async () => {
    await openCard(entry());

    expect(screen.getByText('John Smith · #12 QB')).toBeInTheDocument();
    expect(screen.getByText('John Smith · #37 LB')).toBeInTheDocument();
  });

  it('a unique name on the card is shown exactly as it was', async () => {
    await openCard(entry());

    expect(screen.getByText('Mike Beaudry')).toBeInTheDocument();
    expect(screen.queryByText(/Mike Beaudry ·/)).toBeNull();
  });

  it('with nothing on the roster to show, the name is shown plainly', async () => {
    await openCard(
      entry({
        submitted: [
          { player_name: 'John Smith', submitted_at: '2026-01-01T00:00:00Z', player_id: 21, jersey_number: null, position: null },
        ],
        not_started_players: [
          { player_id: 22, player_name: 'John Smith', jersey_number: null, position: null },
        ],
      }),
    );

    expect(screen.getAllByText('John Smith')).toHaveLength(2);
  });
});

describe('React keys are the person', () => {
  it('two same-named players in ONE column no longer share a key', async () => {
    await openCard(
      entry({
        submitted: [],
        in_progress: [],
        not_started: ['John Smith', 'John Smith'],
        not_started_players: [
          { player_id: 22, player_name: 'John Smith', jersey_number: '37', position: 'LB' },
          { player_id: 23, player_name: 'John Smith', jersey_number: '8', position: 'S' },
        ],
      }),
    );

    expect(screen.getByText('John Smith · #37 LB')).toBeInTheDocument();
    expect(screen.getByText('John Smith · #8 S')).toBeInTheDocument();
    expect(duplicateKeyWarnings()).toEqual([]);
  });

  it('two same-named SUBMITTED players no longer share a key', async () => {
    await openCard(
      entry({
        submitted: [
          { player_name: 'John Smith', submitted_at: '2026-01-01T00:00:00Z', player_id: 21, jersey_number: '12', position: 'QB' },
          { player_name: 'John Smith', submitted_at: '2026-01-01T00:00:00Z', player_id: 22, jersey_number: '37', position: 'LB' },
        ],
        not_started: [],
        not_started_players: [],
      }),
    );

    expect(screen.getByText('John Smith · #12 QB')).toBeInTheDocument();
    expect(duplicateKeyWarnings()).toEqual([]);
  });
});

describe('an older payload without not_started_players', () => {
  it('still lists the names it was given', async () => {
    await openCard(
      entry({
        submitted: [{ player_name: 'Jordan Smith', submitted_at: '2026-01-01T00:00:00Z' }],
        in_progress: [],
        not_started: ['Alex Lee'],
        not_started_players: undefined,
      }),
    );

    expect(screen.getByText('Jordan Smith')).toBeInTheDocument();
    expect(screen.getByText('Alex Lee')).toBeInTheDocument();
  });
});
