import { describe, expect, it } from 'vitest';
import { formatPin } from './formatPin';

describe('formatPin', () => {
  it('groups six digits three and three', () => {
    expect(formatPin('482915')).toBe('482 915');
    expect(formatPin('003948')).toBe('003 948');
  });

  it('leaves anything else exactly as it was rather than inventing a shape', () => {
    expect(formatPin('12345')).toBe('12345');
    expect(formatPin('1234567')).toBe('1234567');
    expect(formatPin('')).toBe('');
  });
});
