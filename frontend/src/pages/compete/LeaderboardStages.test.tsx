/**
 * Standings rendering, and the ordinal/tie rules underneath it.
 *
 * The client is a formatter here: it must never re-rank, and it must never
 * imply a player holds a place they actually share.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Standing } from '../../api/competition';
import { movementLabel, ordinal, rankLabel } from './competitionRank';
import { HostLeaderboard, PlayerStanding } from './LeaderboardStages';

function row(overrides: Partial<Standing> = {}): Standing {
  return {
    participant_id: 1,
    display_name: 'Worthy',
    rank: 1,
    previous_rank: 3,
    movement: 2,
    total_points: 827,
    correct_count: 8,
    scored_rounds: 9,
    current_streak: 1,
    ...overrides,
  };
}

describe('ordinal', () => {
  it.each([
    [1, '1ST'], [2, '2ND'], [3, '3RD'], [4, '4TH'], [5, '5TH'],
    // The teens are the whole reason this helper exists.
    [11, '11TH'], [12, '12TH'], [13, '13TH'],
    [21, '21ST'], [22, '22ND'], [23, '23RD'], [24, '24TH'],
    [101, '101ST'], [111, '111TH'], [112, '112TH'], [113, '113TH'],
  ])('renders %i as %s', (value, expected) => {
    expect(ordinal(value)).toBe(expected);
  });

  it('refuses to invent an ordinal for a nonsense rank', () => {
    expect(ordinal(0)).toBe('—');
    expect(ordinal(Number.NaN)).toBe('—');
  });
});

describe('rankLabel', () => {
  it('marks a shared rank with T-', () => {
    expect(rankLabel(2, 3)).toBe('T-2ND');
    expect(rankLabel(5, 2)).toBe('T-5TH');
  });

  it('leaves a sole rank plain', () => {
    expect(rankLabel(2, 1)).toBe('2ND');
  });
});

describe('movementLabel', () => {
  it('reports a climb, a fall and no change distinctly', () => {
    expect(movementLabel(3)).toMatchObject({ symbol: '▲3', direction: 'up' });
    expect(movementLabel(-2)).toMatchObject({ symbol: '▼2', direction: 'down' });
    expect(movementLabel(0)).toMatchObject({ symbol: '—', direction: 'same' });
  });

  it('treats a missing baseline as NEW, not as unchanged', () => {
    // Claiming somebody held station at a rank nobody was ever shown would be
    // invented movement.
    expect(movementLabel(null)).toMatchObject({ symbol: 'NEW', direction: 'new' });
    expect(movementLabel(undefined).direction).toBe('new');
  });

  it('always carries words as well as a glyph', () => {
    expect(movementLabel(3).text).toBe('Up 3');
    expect(movementLabel(-1).text).toBe('Down 1');
    expect(movementLabel(0).text).toBe('Unchanged');
  });
});

describe('the host table', () => {
  const five = [
    row({ participant_id: 1, display_name: 'Worthy', rank: 1, movement: 2, total_points: 827 }),
    row({ participant_id: 2, display_name: 'Thompson', rank: 2, movement: 0, total_points: 814 }),
    row({ participant_id: 3, display_name: 'Jones', rank: 3, movement: -1, total_points: 728, correct_count: 7 }),
    row({ participant_id: 4, display_name: 'Smith', rank: 4, movement: null, previous_rank: null, total_points: 719, correct_count: 7 }),
    row({ participant_id: 5, display_name: 'Brown', rank: 5, movement: 3, total_points: 632, correct_count: 6 }),
  ];

  it('renders rank, name, movement, correct and points', () => {
    render(<HostLeaderboard standings={five} />);

    expect(screen.getByText('Worthy')).toBeInTheDocument();
    expect(screen.getByText('827')).toBeInTheDocument();
    expect(screen.getByText('▲2')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('▼1')).toBeInTheDocument();
    expect(screen.getByText('NEW')).toBeInTheDocument();
  });

  it('shows the correct count against scored rounds, not the quiz length', () => {
    render(<HostLeaderboard standings={five} />);
    expect(screen.getAllByText('/9').length).toBeGreaterThan(0);
  });

  it('keeps a tied group at the cut line whole', () => {
    // The server returns six rows when fifth is shared; the client must not
    // trim it back to five and drop somebody on a coin flip.
    const tied = [
      ...five,
      row({ participant_id: 6, display_name: 'Diaz', rank: 5, movement: 1, total_points: 632, correct_count: 6 }),
    ];

    render(<HostLeaderboard standings={tied} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(6);
    expect(screen.getByText('Diaz')).toBeInTheDocument();
  });

  it('renders the server order without re-sorting', () => {
    render(<HostLeaderboard standings={five} />);

    const names = screen.getAllByRole('listitem').map((item) => item.textContent ?? '');
    expect(names[0]).toContain('Worthy');
    expect(names[4]).toContain('Brown');
  });

  it('exposes no tokens or answer detail', () => {
    const { container } = render(<HostLeaderboard standings={five} />);
    expect(container.textContent).not.toMatch(/token|selected_option|is_correct/i);
  });

  it('says so plainly when there are no standings', () => {
    render(<HostLeaderboard standings={[]} />);
    expect(screen.getByText(/no standings yet/i)).toBeInTheDocument();
  });
});

describe('a player’s own standing', () => {
  it('shows their place, correct count and points', () => {
    render(
      <PlayerStanding
        standing={row({ rank: 12, movement: 3, correct_count: 6, scored_rounds: 8, total_points: 628 })}
      />,
    );

    expect(screen.getByText('12TH')).toBeInTheDocument();
    expect(screen.getByText('628')).toBeInTheDocument();
    expect(screen.getByText('▲3')).toBeInTheDocument();
  });

  it('marks a shared place as tied rather than sole', () => {
    render(<PlayerStanding standing={row({ rank: 2, tied: 3 })} />);
    expect(screen.getByText('T-2ND')).toBeInTheDocument();
  });

  it('leaves a sole place unqualified', () => {
    render(<PlayerStanding standing={row({ rank: 2, tied: 1 })} />);
    expect(screen.getByText('2ND')).toBeInTheDocument();
  });

  it('says NEW TO THE BOARD on the first standings', () => {
    render(<PlayerStanding standing={row({ movement: null, previous_rank: null })} />);
    expect(screen.getByText(/new to the board/i)).toBeInTheDocument();
  });

  it('shows a zero-point player their place without labelling them', () => {
    const { container } = render(
      <PlayerStanding standing={row({ rank: 7, total_points: 0, correct_count: 0 })} />,
    );

    expect(screen.getByText('7TH')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/last|bottom|no points/i);
  });

  it('shows a streak only from three', () => {
    const { rerender } = render(<PlayerStanding standing={row({ current_streak: 2 })} />);
    expect(screen.queryByText(/in a row/i)).not.toBeInTheDocument();

    rerender(<PlayerStanding standing={row({ current_streak: 4 })} />);
    expect(screen.getByText('4 in a row')).toBeInTheDocument();
  });

  it('describes nobody else', () => {
    const { container } = render(<PlayerStanding standing={row({ display_name: 'Worthy' })} />);
    expect(container.textContent).not.toContain('Thompson');
  });
});
