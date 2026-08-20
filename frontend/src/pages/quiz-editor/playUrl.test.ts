import { describe, expect, it } from 'vitest';
import { playLink } from './playUrl';

describe('playLink', () => {
  it('addresses the play route for that code', () => {
    expect(playLink('ABC234', 'https://peira.example')).toBe(
      'https://peira.example/play/ABC234',
    );
  });

  it('defaults to the origin the coach is actually running', () => {
    // A hard-coded production domain would mean a link shared from a staging
    // build sent a squad to production.
    expect(playLink('ABC234')).toBe(`${window.location.origin}/play/ABC234`);
  });

  it('does not double the slash on an origin with a trailing one', () => {
    expect(playLink('ABC234', 'https://peira.example/')).toBe(
      'https://peira.example/play/ABC234',
    );
  });

  it('trims a code that arrived with whitespace', () => {
    expect(playLink('  ABC234 ', 'https://peira.example')).toBe(
      'https://peira.example/play/ABC234',
    );
  });

  it('CARRIES NOTHING BUT THE CODE', () => {
    // The access code is public - it is read off a whiteboard. A credential is
    // not, and a URL is the worst place for one: links land in history, access
    // logs, Referer headers and, once shared, in a group text read by twenty
    // people. No query string means nothing can be smuggled in later without
    // this failing.
    const url = new global.URL(playLink('ABC234', 'https://peira.example'));

    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(url.pathname).toBe('/play/ABC234');
  });

  it('escapes a code that would otherwise change the path', () => {
    expect(playLink('A/B?c', 'https://peira.example')).toBe(
      'https://peira.example/play/A%2FB%3Fc',
    );
  });
});
