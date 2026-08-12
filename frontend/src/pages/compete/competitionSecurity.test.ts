/**
 * The frontend half of the Competition credential boundary.
 *
 * The backend enforces all of this server-side - none of these tests are the
 * security control. They exist because the CLIENT is where a token would get
 * casually put in a URL for convenience, or written to localStorage "so it
 * survives a refresh", and either would hand the credential to somewhere it
 * does not belong. These fail if that ever happens.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as competitionApi from '../../api/competition';
import { clearSeat, readSeat, seatFor, writeSeat } from './competitionSeat';

const TOKEN = 'sekrit-opaque-token-value-abc123';

function mockFetch(body: unknown = {}, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: String(url), init: (init ?? {}) as RequestInit };
}

function headerValue(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('the seat token in transit', () => {
  it('travels in X-Competition-Token on reconnect', async () => {
    const fetchMock = mockFetch({ participant: {}, status: 'LOBBY', version: 1 });

    await competitionApi.resumeCompetition('ABC123', TOKEN);

    const { init } = lastCall(fetchMock);
    expect(headerValue(init, 'X-Competition-Token')).toBe(TOKEN);
  });

  it('never appears in the URL on reconnect', async () => {
    const fetchMock = mockFetch({ participant: {}, status: 'LOBBY', version: 1 });

    await competitionApi.resumeCompetition('ABC123', TOKEN);

    const { url } = lastCall(fetchMock);
    // A path or query parameter would be recorded in access logs, browser
    // history and Referer headers.
    expect(url).not.toContain(TOKEN);
    expect(url).not.toContain('?');
    expect(url).toMatch(/\/competition\/ABC123\/me$/);
  });

  it('never appears in the URL on a join retry', async () => {
    const fetchMock = mockFetch({ participant: {}, reconnect_token: TOKEN });

    await competitionApi.joinCompetition('ABC123', 7, TOKEN);

    const { url, init } = lastCall(fetchMock);
    expect(url).not.toContain(TOKEN);
    expect(headerValue(init, 'X-Competition-Token')).toBe(TOKEN);
  });

  it('is not sent at all on a first join', async () => {
    const fetchMock = mockFetch({ participant: {}, reconnect_token: TOKEN });

    await competitionApi.joinCompetition('ABC123', 7);

    const { init } = lastCall(fetchMock);
    expect(headerValue(init, 'X-Competition-Token')).toBeUndefined();
  });

  it('sends no coach JWT on the public player routes', async () => {
    localStorage.setItem('football_quiz_access_token', 'a-coach-jwt');
    const fetchMock = mockFetch({ version: 1, status: 'LOBBY' });

    await competitionApi.pollState('ABC123');

    // A shared or borrowed phone must not carry a coach's credential into a
    // public endpoint.
    expect(headerValue(lastCall(fetchMock).init, 'Authorization')).toBeUndefined();
  });

  it('exposes no API that authenticates with an id', () => {
    // A guard against the deleted /me/<player_id> route coming back in any
    // shape: nothing in the client may take an id as proof of identity.
    const source = Object.keys(competitionApi);
    expect(source).toContain('resumeCompetition');
    expect(competitionApi.resumeCompetition.length).toBe(2); // (joinCode, token)
    expect(source).not.toContain('resumeByPlayerId');
    expect(source).not.toContain('resumeByParticipantId');
  });
});

describe('where the seat is stored', () => {
  it('round-trips through sessionStorage', () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });
    expect(readSeat()).toEqual({
      joinCode: 'ABC123',
      token: TOKEN,
      displayName: 'Ada Lovelace',
    });
  });

  it('never writes the token to localStorage', () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });

    // A competition is one sitting in one room. A token that outlives the tab
    // is a credential left on a shared phone.
    expect(JSON.stringify(localStorage)).not.toContain(TOKEN);
    expect(localStorage.length).toBe(0);
  });

  it('stores no roster and no ids', () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });

    const stored = JSON.parse(sessionStorage.getItem('peira_competition_seat') as string);
    // Other people's names are not this device's business to keep, and an id
    // in storage is an invitation to authenticate with it later.
    expect(Object.keys(stored).sort()).toEqual(['displayName', 'joinCode', 'token']);
    expect(stored).not.toHaveProperty('player_id');
    expect(stored).not.toHaveProperty('participant_id');
    expect(stored).not.toHaveProperty('roster');
  });

  it('clears completely when the seat dies', () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });

    clearSeat();

    expect(readSeat()).toBeNull();
    expect(JSON.stringify(sessionStorage)).not.toContain(TOKEN);
  });

  it('does not offer a seat from a different competition', () => {
    writeSeat({ joinCode: 'ABC123', token: TOKEN, displayName: 'Ada Lovelace' });

    // Replaying one competition's token at another is exactly what the server
    // rejects; the client should not even attempt it.
    expect(seatFor('ZZZ999')).toBeNull();
    expect(seatFor('abc123')).not.toBeNull(); // same code, typed lowercase
  });

  it('treats a half-written seat as no seat', () => {
    sessionStorage.setItem('peira_competition_seat', JSON.stringify({ joinCode: 'ABC123' }));

    // A seat with no token produces a reconnect that can never succeed - and
    // a retry loop is exactly what must not happen.
    expect(readSeat()).toBeNull();
  });

  it('treats unparseable storage as no seat', () => {
    sessionStorage.setItem('peira_competition_seat', 'not json at all');
    expect(readSeat()).toBeNull();
  });
});
