import { beforeEach, describe, expect, it } from 'vitest';
import { readAttemptToken, saveAttemptToken } from './attemptToken';
import { forgetPlayer, playerTag, rememberPlayer, rememberedPlayer, wasActiveInThisTab } from './playerSession';

/** WHO PLAYS ON THIS DEVICE - and the shared-phone rule that at most ONE
 *  player's token per code is ever kept, and only for the remembered player. */

const JORDAN = { playerId: 501, name: 'Jordan Smith', jerseyNumber: '7', position: 'QB' };
const CHRIS = { playerId: 502, name: 'Chris Smith', jerseyNumber: '9', position: null };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('playerSession', () => {
  it('remembers one player per code, case-insensitively', () => {
    rememberPlayer('abc123', JORDAN);
    expect(rememberedPlayer('ABC123')).toEqual(JORDAN);
    expect(rememberedPlayer('OTHER1')).toBeNull();
  });

  it('remembering a player forgets every other player’s token for that code', () => {
    saveAttemptToken('ABC123', 501, 'jordan');
    saveAttemptToken('ABC123', 502, 'chris');
    saveAttemptToken('OTHER1', 502, 'chris-elsewhere');

    rememberPlayer('ABC123', CHRIS);

    expect(readAttemptToken('ABC123', 501)).toBeNull();
    expect(readAttemptToken('ABC123', 502)).toBe('chris');
    expect(readAttemptToken('OTHER1', 502)).toBe('chris-elsewhere');
  });

  it('"Not you?" forgets the player, their token and the open-quiz marker', () => {
    rememberPlayer('ABC123', JORDAN);
    saveAttemptToken('ABC123', 501, 'jordan');
    expect(wasActiveInThisTab('ABC123')).toBe(true);

    forgetPlayer('ABC123');

    expect(rememberedPlayer('ABC123')).toBeNull();
    expect(readAttemptToken('ABC123', 501)).toBeNull();
    expect(wasActiveInThisTab('ABC123')).toBe(false);
  });

  it('keeps nothing but the identity - no PIN, no token', () => {
    rememberPlayer('ABC123', JORDAN);
    const stored = localStorage.getItem('peira.play.session.v1:ABC123') ?? '';
    expect(JSON.parse(stored)).toEqual(JORDAN);
  });

  it('a corrupted entry reads as nobody remembered', () => {
    localStorage.setItem('peira.play.session.v1:ABC123', '{not json');
    expect(rememberedPlayer('ABC123')).toBeNull();
    localStorage.setItem('peira.play.session.v1:ABC123', JSON.stringify({ name: '' }));
    expect(rememberedPlayer('ABC123')).toBeNull();
  });

  it('a new tab is not "active" - only a refresh of the same tab resumes without a tap', () => {
    rememberPlayer('ABC123', JORDAN);
    sessionStorage.clear(); // a new tab starts with empty sessionStorage
    expect(rememberedPlayer('ABC123')).toEqual(JORDAN);
    expect(wasActiveInThisTab('ABC123')).toBe(false);
  });

  it('tags a name with jersey and position when known', () => {
    expect(playerTag(JORDAN)).toBe('#7 · QB');
    expect(playerTag(CHRIS)).toBe('#9');
    expect(playerTag({ jerseyNumber: null, position: null })).toBe('');
  });
});
