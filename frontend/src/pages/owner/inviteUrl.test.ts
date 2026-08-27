import { describe, expect, it } from 'vitest';
import { inviteLink } from './inviteUrl';

/** The CONTENT of the link, asserted exactly.
 *
 * Same reasoning as playUrl.test and joinUrl.test: clipboards, share sheets and
 * QR renderers only move a string around, so the string is the thing worth
 * pinning. This one carries a credential, which makes "exactly the token and
 * nothing else" a security property rather than a tidiness one.
 */
describe('inviteLink', () => {
  it('points at the EXISTING invite registration route', () => {
    expect(inviteLink('PEIRA-K7M4-QX92-BD3F', 'https://peira.test')).toBe(
      'https://peira.test/invite/PEIRA-K7M4-QX92-BD3F',
    );
  });

  it('carries the token and nothing else', () => {
    const url = inviteLink('PEIRA-K7M4-QX92-BD3F', 'https://peira.test');

    expect(url.split('/invite/')[1]).toBe('PEIRA-K7M4-QX92-BD3F');
    expect(url).not.toMatch(/\?|&|token=|key=/);
  });

  it('does not double a trailing slash on the origin', () => {
    expect(inviteLink('PEIRA-AAAA-BBBB-CCCC', 'https://peira.test/')).toBe(
      'https://peira.test/invite/PEIRA-AAAA-BBBB-CCCC',
    );
  });

  it('trims what the caller passes', () => {
    expect(inviteLink('  PEIRA-AAAA-BBBB-CCCC  ', 'https://peira.test')).toBe(
      'https://peira.test/invite/PEIRA-AAAA-BBBB-CCCC',
    );
  });

  it('derives the origin from the running app when none is given', () => {
    // Hard-coding a domain would send a coach from a staging build into
    // production.
    expect(inviteLink('PEIRA-AAAA-BBBB-CCCC')).toBe(
      `${window.location.origin}/invite/PEIRA-AAAA-BBBB-CCCC`,
    );
  });
});
