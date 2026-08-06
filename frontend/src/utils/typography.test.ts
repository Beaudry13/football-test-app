import { describe, expect, it } from 'vitest';
import { renderArrows } from './typography';

describe('renderArrows', () => {
  it('renders a typed right arrow as a real arrow glyph', () => {
    expect(renderArrows('WR -> flat')).toBe('WR → flat');
  });

  it('renders a typed left arrow', () => {
    expect(renderArrows('flat <- WR')).toBe('flat ← WR');
  });

  it('treats longer dash runs as the same arrow', () => {
    expect(renderArrows('Cover 3 --> Cover 1')).toBe('Cover 3 → Cover 1');
    expect(renderArrows('Cover 3 ---> Cover 1')).toBe('Cover 3 → Cover 1');
  });

  it('keeps both heads of a double-headed arrow', () => {
    // The left rule has to run first, or "->" is consumed and the left head
    // is left stranded as a bare "<".
    expect(renderArrows('Mike <-> Will')).toBe('Mike ←> Will');
  });

  it('handles several arrows in one question', () => {
    expect(renderArrows('Cover 3 -> Cover 1 -> Cover 0')).toBe('Cover 3 → Cover 1 → Cover 0');
  });

  it('works without surrounding spaces', () => {
    expect(renderArrows('X->Y')).toBe('X→Y');
  });

  it('leaves an ordinary hyphen alone', () => {
    expect(renderArrows('Man-to-Man coverage')).toBe('Man-to-Man coverage');
  });

  it('leaves a horizontal rule of dashes alone', () => {
    expect(renderArrows('-----')).toBe('-----');
  });

  it('leaves a bare greater-than alone', () => {
    // "3 > 2" is a comparison, not a direction.
    expect(renderArrows('Leverage > technique')).toBe('Leverage > technique');
  });

  it('leaves a fat arrow alone', () => {
    expect(renderArrows('a => b')).toBe('a => b');
  });

  it('passes through text with no arrows unchanged', () => {
    const text = 'In Cover 6 vs a tight #1, who is the corner calling?';
    expect(renderArrows(text)).toBe(text);
  });

  it('handles an empty string', () => {
    expect(renderArrows('')).toBe('');
  });

  it('does not mutate its input', () => {
    const original = 'WR -> flat';
    renderArrows(original);
    expect(original).toBe('WR -> flat');
  });
});
