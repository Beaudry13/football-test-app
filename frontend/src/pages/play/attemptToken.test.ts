import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTEMPT_TOKEN_HEADER,
  attemptTokenHeaders,
  attemptTokenKey,
  clearAttemptToken,
  readAttemptToken,
  saveAttemptToken,
} from './attemptToken';

/** The device's copy of an attempt token. What matters: only the token is
 *  kept, it is kept per code AND per player, and it goes nowhere near a URL. */

const TOKEN = 'k8Jx3-token-value_aaaaaaaaaaaaaaaaaaaaaaaaaaaa';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => vi.restoreAllMocks());

describe('saving and reading', () => {
  it('round-trips a token', () => {
    expect(saveAttemptToken('abc123', 21, TOKEN)).toBe(true);
    expect(readAttemptToken('ABC123', 21)).toBe(TOKEN);
  });

  it('normalises the code the way players type it', () => {
    saveAttemptToken('  abc123 ', 21, TOKEN);
    expect(readAttemptToken('ABC123', 21)).toBe(TOKEN);
  });

  it('clears', () => {
    saveAttemptToken('ABC123', 21, TOKEN);
    clearAttemptToken('ABC123', 21);
    expect(readAttemptToken('ABC123', 21)).toBeNull();
  });

  it('returns null when nothing is stored', () => {
    expect(readAttemptToken('ABC123', 21)).toBeNull();
  });
});

describe('isolation', () => {
  it('keeps two players on one phone apart', () => {
    saveAttemptToken('ABC123', 21, 'token-for-21');
    saveAttemptToken('ABC123', 22, 'token-for-22');
    expect(readAttemptToken('ABC123', 21)).toBe('token-for-21');
    expect(readAttemptToken('ABC123', 22)).toBe('token-for-22');
  });

  it('keeps one player on two codes apart', () => {
    saveAttemptToken('ABC123', 21, 'first-code');
    saveAttemptToken('XYZ789', 21, 'second-code');
    expect(readAttemptToken('ABC123', 21)).toBe('first-code');
    expect(readAttemptToken('XYZ789', 21)).toBe('second-code');
  });

  it('clearing one leaves the others', () => {
    saveAttemptToken('ABC123', 21, 'a');
    saveAttemptToken('ABC123', 22, 'b');
    clearAttemptToken('ABC123', 21);
    expect(readAttemptToken('ABC123', 22)).toBe('b');
  });

  it('keys by code and canonical player id', () => {
    expect(attemptTokenKey('abc123', 21)).toBe('peira.attempt.token:ABC123:21');
  });
});

describe('what is stored, and where', () => {
  it('stores the token and nothing else', () => {
    saveAttemptToken('ABC123', 21, TOKEN);
    expect(Object.keys(localStorage)).toEqual(['peira.attempt.token:ABC123:21']);
    expect(localStorage.getItem('peira.attempt.token:ABC123:21')).toBe(TOKEN);
    expect(sessionStorage.length).toBe(0);
  });

  it('never touches the URL', () => {
    const before = window.location.href;
    saveAttemptToken('ABC123', 21, TOKEN);
    readAttemptToken('ABC123', 21);
    expect(window.location.href).toBe(before);
    expect(window.location.href).not.toContain(TOKEN);
  });

  it('refuses unusable input rather than writing a junk key', () => {
    expect(saveAttemptToken('', 21, TOKEN)).toBe(false);
    expect(saveAttemptToken('ABC123', 0, TOKEN)).toBe(false);
    expect(saveAttemptToken('ABC123', 21, '   ')).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('survives storage being unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(saveAttemptToken('ABC123', 21, TOKEN)).toBe(false);
    expect(readAttemptToken('ABC123', 21)).toBeNull();
  });
});

describe('the header', () => {
  it('names the header the backend reads', () => {
    expect(ATTEMPT_TOKEN_HEADER).toBe('X-Attempt-Token');
    expect(attemptTokenHeaders(TOKEN)).toEqual({ 'X-Attempt-Token': TOKEN });
  });

  it('is empty without a token', () => {
    expect(attemptTokenHeaders(null)).toEqual({});
  });
});
