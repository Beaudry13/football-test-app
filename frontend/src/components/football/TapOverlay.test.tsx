import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TapOverlay } from './TapOverlay';
import { placeRows, spreadTargets, usableTargets } from './tapTargets';

/**
 * THE ANSWERS, IN THE PICTURE - one layer for Quiz, Rep, Review, Teach and the
 * coach's check. Every answer must stay readable and tappable, however close
 * its man or its spot stands to another.
 */

const options = (...texts: string[]) => texts.map((option_text, id) => ({ id, option_text }));

describe('which answers share a row', () => {
  it('a line of gaps a yard or two apart share one row, across the field', () => {
    const gaps = [0.47, 0.44, 0.41, 0.38].map((x) => ({ x, y: 0.5, zone: true }));
    expect(placeRows(gaps)).toEqual([[3, 2, 1, 0]]);
  });

  it('a slot and a tight end side by side share a row; a man out wide keeps his ring', () => {
    const men = [
      { x: 0.17, y: 0.59 }, // X, alone
      { x: 0.58, y: 0.62 }, // H, motioned beside the Y
      { x: 0.6, y: 0.59 }, // Y
    ];
    expect(placeRows(men)).toEqual([[0], [1, 2]]);
  });

  it('men and places never share a row', () => {
    expect(placeRows([{ x: 0.5, y: 0.5 }, { x: 0.52, y: 0.5, zone: true }])).toHaveLength(2);
  });

  it('targets are used only one per answer, with a picture to tap', () => {
    const t = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }];
    expect(usableTargets(t, 2, true)).toBe(t);
    expect(usableTargets(t, 3, true)).toBeNull();
    expect(usableTargets(t, 2, false)).toBeNull();
    expect(spreadTargets(3).map((s) => s.zone)).toEqual([true, true, true]);
  });
});

describe('the overlay', () => {
  it('a man standing clear is a ring on him; men side by side are labelled buttons over a dot on each', () => {
    const onTap = vi.fn();
    const { container } = render(
      <TapOverlay
        targets={[
          { x: 0.17, y: 0.59 },
          { x: 0.58, y: 0.62 },
          { x: 0.6, y: 0.59 },
        ]}
        options={options('X', 'H', 'Y')}
        onTap={onTap}
      />,
    );
    expect(screen.getByRole('button', { name: 'Tap X' })).toHaveTextContent('');
    expect(screen.getByRole('button', { name: 'Tap H' })).toHaveTextContent('H');
    expect(screen.getByRole('button', { name: 'Tap Y' })).toHaveTextContent('Y');
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Tap Y' }));
    expect(onTap).toHaveBeenCalledWith(2);
  });

  it("in the coach's check a place moves, a man does not", () => {
    const onMove = vi.fn();
    render(
      <TapOverlay
        targets={[
          { x: 0.3, y: 0.6 },
          { x: 0.7, y: 0.2, zone: true },
        ]}
        options={options('Z', 'Deep third')}
        onMove={onMove}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Move Z' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Move Deep third' })).toBeInTheDocument();
  });
});
