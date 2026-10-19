import { describe, expect, it } from 'vitest';
import type { Player } from '../../api/types';
import { audiencesFrom, pluralFor, suggestedFamily } from './audiences';

/** WHO A REP GOES TO, from the roster's own positions. */

const player = (id: number, position: string | null, is_active = true) => ({ id, position, is_active }) as unknown as Player;

describe('audiences from the roster', () => {
  it('groups positions into the families coaches use, showing exactly which positions and how many', () => {
    const chips = audiencesFrom([
      player(1, 'S'),
      player(2, 'FS'),
      player(3, 'ss'),
      player(4, 'CB'),
      player(5, 'CB'),
      player(6, 'K'),
      player(7, 'S', false),
      player(8, null),
    ]);
    expect(chips.map((c) => [c.name, c.positions, c.playerIds])).toEqual([
      ['Safeties', ['FS', 'S', 'SS'], [1, 2, 3]],
      ['Corners', ['CB'], [4, 5]],
      ['K', ['K'], [6]],
    ]);
  });

  it("suggests the family a Rep's roles point at - only when they agree", () => {
    expect(suggestedFamily(['Boundary safety', 'Field safety'])?.name).toBe('Safeties');
    expect(suggestedFamily(['Mike'])?.name).toBe('Linebackers');
    expect(suggestedFamily(['Left tackle'])?.name).toBe('Offensive line');
    expect(suggestedFamily(['Boundary safety', 'Corner'])).toBeNull();
    expect(suggestedFamily([null])).toBeNull();
  });

  it('says them in a sentence when they are one family', () => {
    expect(pluralFor(['FS', 'S'])).toBe('safeties');
    expect(pluralFor(['S', 'CB'])).toBeNull();
    expect(pluralFor([])).toBeNull();
  });
});
