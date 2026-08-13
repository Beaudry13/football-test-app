/**
 * The ending on screen.
 *
 * The empty-place cases matter most: standard competition ranking can leave a
 * place with nobody in it, and the screen must say so rather than skipping the
 * beat or promoting the next player up.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Podium, PodiumEntry, Standing } from '../../api/competition';
import { HostPodium, PlayerPodium } from './PodiumStages';

function entry(name: string, rank: number, points: number): PodiumEntry {
  return {
    participant_id: name.length + rank * 100,
    display_name: name,
    rank,
    total_points: points,
    correct_count: 8,
    scored_rounds: 9,
  };
}

function standing(overrides: Partial<Standing> = {}): Standing {
  return {
    participant_id: 1,
    display_name: 'Worthy',
    rank: 2,
    previous_rank: 2,
    movement: 0,
    total_points: 814,
    correct_count: 8,
    scored_rounds: 9,
    current_streak: 2,
    ...overrides,
  };
}

function podium(overrides: Partial<Podium> = {}): Podium {
  return {
    step: 0,
    last_step: 4,
    places: {
      '1': [entry('Worthy', 1, 827)],
      '2': [entry('Thompson', 2, 814)],
      '3': [entry('Jones', 3, 728)],
    },
    empty_places: [],
    winners: ['Worthy'],
    final_standings: [
      standing({ participant_id: 1, display_name: 'Worthy', rank: 1, total_points: 827 }),
      standing({ participant_id: 2, display_name: 'Thompson', rank: 2, total_points: 814 }),
      standing({ participant_id: 3, display_name: 'Jones', rank: 3, total_points: 728 }),
    ],
    ...overrides,
  };
}

const result = { ...standing(), best_streak: 4, is_winner: false };

describe('the host podium', () => {
  it('opens on a competition-complete beat, not on third place', () => {
    render(<HostPodium podium={podium({ step: 0 })} />);

    expect(screen.getByText(/competition complete/i)).toBeInTheDocument();
    expect(screen.queryByText('Jones')).not.toBeInTheDocument();
  });

  it('reveals one place at a time, in order', () => {
    const { rerender } = render(<HostPodium podium={podium({ step: 1 })} />);
    expect(screen.getByText('3rd place')).toBeInTheDocument();
    expect(screen.getByText('Jones')).toBeInTheDocument();
    // The winner is not on screen yet.
    expect(screen.queryByText('Worthy')).not.toBeInTheDocument();

    rerender(<HostPodium podium={podium({ step: 2 })} />);
    expect(screen.getByText('2nd place')).toBeInTheDocument();
    expect(screen.queryByText('Worthy')).not.toBeInTheDocument();

    rerender(<HostPodium podium={podium({ step: 3 })} />);
    expect(screen.getByText('1st place')).toBeInTheDocument();
    expect(screen.getByText('Worthy')).toBeInTheDocument();
  });

  it('shows points and the correct count with each place', () => {
    render(<HostPodium podium={podium({ step: 3 })} />);

    expect(screen.getByText('827')).toBeInTheDocument();
    expect(screen.getByText('8/9 correct')).toBeInTheDocument();
  });

  it('names the place with words, not just position', () => {
    render(<HostPodium podium={podium({ step: 3 })} />);
    // A washed-out projector and a screen reader both need the text.
    expect(screen.getByText('1st place')).toBeInTheDocument();
  });

  it('shows tied winners together, each with their own numbers', () => {
    render(
      <HostPodium
        podium={podium({
          step: 3,
          places: {
            '1': [entry('Worthy', 1, 827), entry('Thompson', 1, 827)],
            '2': [],
            '3': [entry('Jones', 3, 728)],
          },
          empty_places: [2],
          winners: ['Worthy', 'Thompson'],
        })}
      />,
    );

    expect(screen.getByText('Worthy')).toBeInTheDocument();
    expect(screen.getByText('Thompson')).toBeInTheDocument();
    // Not collapsed into one fabricated combined score.
    expect(screen.getAllByText('827')).toHaveLength(2);
  });

  it('says a place was not awarded rather than promoting somebody', () => {
    render(
      <HostPodium
        podium={podium({
          step: 2,
          places: { '1': [entry('Worthy', 1, 827), entry('Thompson', 1, 827)], '2': [], '3': [entry('Jones', 3, 728)] },
          empty_places: [2],
        })}
      />,
    );

    expect(screen.getByText(/no 2nd place/i)).toBeInTheDocument();
    expect(screen.getByText(/tie at the top/i)).toBeInTheDocument();
    // Third place must NOT be pulled up into the gap.
    expect(screen.queryByText('Jones')).not.toBeInTheDocument();
  });

  it('lists everyone in the final standings, not a top five', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      standing({ participant_id: i + 1, display_name: `Player${i + 1}`, rank: i + 1 }),
    );

    render(<HostPodium podium={podium({ step: 4, final_standings: many })} />);

    expect(screen.getAllByRole('listitem')).toHaveLength(9);
    expect(screen.getByText('Player9')).toBeInTheDocument();
  });

  it('exposes no tokens or answer detail', () => {
    const { container } = render(<HostPodium podium={podium({ step: 4 })} />);
    expect(container.textContent).not.toMatch(/token|selected_option|is_correct/i);
  });
});

describe('a player during the podium', () => {
  it('follows the room rather than showing a stale screen', () => {
    render(<PlayerPodium podium={podium({ step: 0 })} result={result} />);

    expect(screen.getByText(/competition complete/i)).toBeInTheDocument();
    // No answer controls, no leaderboard, no question.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('tells a player when the place being revealed is theirs', () => {
    render(<PlayerPodium podium={podium({ step: 2 })} result={{ ...result, rank: 2 }} />);
    expect(screen.getByText(/you finished 2nd/i)).toBeInTheDocument();
  });

  it('shows the names when the place is not theirs', () => {
    render(<PlayerPodium podium={podium({ step: 3 })} result={{ ...result, rank: 5 }} />);

    expect(screen.getByText('1st place')).toBeInTheDocument();
    expect(screen.getByText('Worthy')).toBeInTheDocument();
    expect(screen.queryByText(/you finished/i)).not.toBeInTheDocument();
  });

  it('reports an unawarded place honestly on the phone too', () => {
    render(
      <PlayerPodium
        podium={podium({ step: 2, places: { '1': [], '2': [], '3': [] }, empty_places: [2] })}
        result={{ ...result, rank: 5 }}
      />,
    );

    expect(screen.getByText(/not awarded/i)).toBeInTheDocument();
  });

  it('shows the final result with a tie-aware ordinal', () => {
    render(
      <PlayerPodium
        podium={podium({ step: 4 })}
        result={{ ...result, rank: 2, tied: 3 }}
      />,
    );

    expect(screen.getByText('T-2ND')).toBeInTheDocument();
    expect(screen.getByText(/your final result/i)).toBeInTheDocument();
    expect(screen.getByText('814')).toBeInTheDocument();
  });

  it('leaves a sole rank unqualified', () => {
    render(
      <PlayerPodium podium={podium({ step: 4 })} result={{ ...result, rank: 4, tied: 1 }} />,
    );
    expect(screen.getByText('4TH')).toBeInTheDocument();
  });

  it('shows the best streak only when it is worth mentioning', () => {
    const { rerender } = render(
      <PlayerPodium podium={podium({ step: 4 })} result={{ ...result, best_streak: 2 }} />,
    );
    expect(screen.queryByText(/best streak/i)).not.toBeInTheDocument();

    rerender(
      <PlayerPodium podium={podium({ step: 4 })} result={{ ...result, best_streak: 5 }} />,
    );
    expect(screen.getByText('Best streak 5')).toBeInTheDocument();
  });

  it('never names another player on the final result screen', () => {
    const { container } = render(
      <PlayerPodium podium={podium({ step: 4 })} result={{ ...result, display_name: 'Me' }} />,
    );
    expect(container.textContent).not.toContain('Thompson');
  });
});
