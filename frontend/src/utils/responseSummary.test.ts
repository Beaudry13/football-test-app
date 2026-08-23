import { describe, expect, it } from 'vitest';
import { hasResponseDenominator, responseSummary } from './responseSummary';

describe('responseSummary', () => {
  it('THE RULE: never prints "N of 0" when N is greater than zero', () => {
    // The state that shipped. roster_size is who is eligible under the
    // currently active code; it goes to zero the moment that code expires,
    // while completed_count keeps every submission the quiz ever received.
    expect(responseSummary(17, 0)).toBe('17 answered');
    expect(responseSummary(1, 0)).toBe('1 answered');
    expect(responseSummary(999, 0)).toBe('999 answered');
  });

  it('keeps the fraction whenever a denominator genuinely exists', () => {
    expect(responseSummary(18, 24)).toBe('18 of 24');
    expect(responseSummary(0, 24)).toBe('0 of 24');
    expect(responseSummary(24, 24)).toBe('24 of 24');
  });

  it('treats a MISSING roster_size the same as a zero one', () => {
    // Single-quiz responses omit the key rather than sending 0.
    expect(responseSummary(17, undefined)).toBe('17 answered');
  });

  it('says nothing when there is no count to report', () => {
    // completed_count is omitted on responses that never computed it, and the
    // caller must render nothing at all rather than a zero.
    expect(responseSummary(undefined, 24)).toBeNull();
    expect(responseSummary(undefined, undefined)).toBeNull();
  });

  it('does not call an untouched quiz a failure', () => {
    // Nobody eligible and nobody answered is the state of a brand-new quiz.
    // "0 answered" reads like something went wrong.
    expect(responseSummary(0, 0)).toBe('No responses yet');
    expect(responseSummary(0, undefined)).toBe('No responses yet');
  });

  it('never emits the substring " of 0"', () => {
    // The regression stated directly, across the whole neighbourhood of the
    // bug, so no future rewrite of the wording can reintroduce it.
    for (const n of [0, 1, 2, 17, 100]) {
      for (const r of [undefined, 0]) {
        expect(responseSummary(n, r)).not.toMatch(/ of 0$/);
      }
    }
  });
});

describe('hasResponseDenominator', () => {
  it('is false for the values that must never become a denominator', () => {
    expect(hasResponseDenominator(0)).toBe(false);
    expect(hasResponseDenominator(undefined)).toBe(false);
  });

  it('is true only for a real roster', () => {
    expect(hasResponseDenominator(1)).toBe(true);
    expect(hasResponseDenominator(24)).toBe(true);
  });
});
