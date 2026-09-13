import { describe, expect, it } from 'vitest';
import { collisionKey, playerDetail, playerLabels, type PlayerLabelInput } from './playerDisplayLabel';

/** The rules behind every duplicate-name label on a coach or player screen.
 *
 * The one that matters most is the first: a unique name comes back EXACTLY as
 * it went in. Metadata beside every name is the failure this helper exists to
 * avoid, and it is the easiest one to introduce by accident.
 */

const texts = (items: PlayerLabelInput[], mode: 'attempt' | 'roster') =>
  playerLabels(items, (i) => i, mode).map((l) => l.text);

describe('only when necessary', () => {
  it('leaves a unique name exactly as it was, metadata or not', () => {
    const labels = playerLabels(
      [
        { name: 'Mike Beaudry', jerseyNumber: '4', position: 'QB' },
        { name: 'John Smith', jerseyNumber: '12', position: 'QB' },
      ],
      (i) => i,
      'roster',
    );
    expect(labels[0]).toEqual({ name: 'Mike Beaudry', detail: null, text: 'Mike Beaudry' });
    expect(labels[1].text).toBe('John Smith');
  });

  it('an empty list is fine', () => {
    expect(playerLabels([], (i: PlayerLabelInput) => i, 'roster')).toEqual([]);
  });
});

describe('attempt mode: jersey only', () => {
  it('labels duplicates by jersey and never appends position', () => {
    expect(
      texts(
        [
          { name: 'John Smith', jerseyNumber: '12', position: 'QB' },
          { name: 'John Smith', jerseyNumber: '37', position: 'LB' },
        ],
        'attempt',
      ),
    ).toEqual(['John Smith · #12', 'John Smith · #37']);
  });

  it('a duplicate with no jersey shows the name plainly', () => {
    expect(
      texts(
        [
          { name: 'John Smith', jerseyNumber: '12' },
          { name: 'John Smith', jerseyNumber: null, position: 'LB' },
        ],
        'attempt',
      ),
    ).toEqual(['John Smith · #12', 'John Smith']);
  });
});

describe('roster mode: jersey and position', () => {
  it('labels duplicates with both', () => {
    expect(
      texts(
        [
          { name: 'John Smith', jerseyNumber: '12', position: 'QB' },
          { name: 'John Smith', jerseyNumber: '37', position: 'LB' },
        ],
        'roster',
      ),
    ).toEqual(['John Smith · #12 QB', 'John Smith · #37 LB']);
  });

  it.each([
    ['jersey + position', { jerseyNumber: '12', position: 'QB' }, '#12 QB'],
    ['jersey only', { jerseyNumber: '12', position: null }, '#12'],
    ['position only', { jerseyNumber: null, position: 'QB' }, 'QB'],
    ['neither', { jerseyNumber: null, position: null }, null],
    ['blank strings count as absent', { jerseyNumber: '  ', position: '' }, null],
  ])('%s', (_case, meta, expected) => {
    expect(playerDetail({ name: 'John Smith', ...meta }, 'roster')).toBe(expected);
  });

  it('the neither case falls back to the bare name, inventing nothing', () => {
    const labels = playerLabels(
      [{ name: 'John Smith' }, { name: 'John Smith' }],
      (i) => i,
      'roster',
    );
    expect(labels.map((l) => l.text)).toEqual(['John Smith', 'John Smith']);
    expect(labels.every((l) => l.detail === null)).toBe(true);
  });

  it('does not double a # the coach typed into the jersey field', () => {
    expect(playerDetail({ name: 'x', jerseyNumber: '#12' }, 'roster')).toBe('#12');
  });
});

describe('detection', () => {
  it('trims, collapses whitespace and ignores case', () => {
    expect(collisionKey('  John   Smith ')).toBe('john smith');
    expect(
      texts(
        [
          { name: 'John Smith', jerseyNumber: '1' },
          { name: 'john smith', jerseyNumber: '2' },
          { name: 'John  Smith', jerseyNumber: '3' },
        ],
        'attempt',
      ),
    ).toEqual(['John Smith · #1', 'john smith · #2', 'John  Smith · #3']);
  });

  it('never rewrites the displayed name', () => {
    const [label] = playerLabels(
      [{ name: 'john  SMITH', jerseyNumber: '1' }, { name: 'John Smith', jerseyNumber: '2' }],
      (i) => i,
      'attempt',
    );
    expect(label.name).toBe('john  SMITH');
  });

  it('is scoped to the list it is given', () => {
    // Same person-name, two separate renders: neither list has a collision.
    expect(texts([{ name: 'John Smith', jerseyNumber: '12' }], 'attempt')).toEqual(['John Smith']);
    expect(texts([{ name: 'John Smith', jerseyNumber: '37' }], 'attempt')).toEqual(['John Smith']);
  });

  it('labels only the colliding names in a mixed list', () => {
    expect(
      texts(
        [
          { name: 'John Smith', jerseyNumber: '12' },
          { name: 'Mike Beaudry', jerseyNumber: '4' },
          { name: 'John Smith', jerseyNumber: '37' },
        ],
        'attempt',
      ),
    ).toEqual(['John Smith · #12', 'Mike Beaudry', 'John Smith · #37']);
  });
});

describe('a collision is between people, not rows', () => {
  it('one player listed twice is not ambiguous with themselves', () => {
    expect(
      texts(
        [
          { name: 'John Smith', jerseyNumber: '12', identity: 5 },
          { name: 'John Smith', jerseyNumber: '12', identity: 5 },
        ],
        'attempt',
      ),
    ).toEqual(['John Smith', 'John Smith']);
  });

  it('but a second person with that name still labels both of them', () => {
    expect(
      texts(
        [
          { name: 'John Smith', jerseyNumber: '12', identity: 5 },
          { name: 'John Smith', jerseyNumber: '12', identity: 5 },
          { name: 'John Smith', jerseyNumber: '37', identity: 6 },
        ],
        'attempt',
      ),
    ).toEqual(['John Smith · #12', 'John Smith · #12', 'John Smith · #37']);
  });

  it('rows without an identity are each their own person', () => {
    expect(
      texts([{ name: 'John Smith', jerseyNumber: '1' }, { name: 'John Smith', jerseyNumber: '2' }], 'attempt'),
    ).toEqual(['John Smith · #1', 'John Smith · #2']);
  });
});
