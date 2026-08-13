/**
 * The scan-to-join QR: what it points at, and what it must never carry.
 *
 * These assert the URL rather than the rendered matrix. The squares are the
 * library's job and pixel assertions on them would break on any upgrade
 * without ever catching a real fault; the DESTINATION is ours, and a wrong or
 * leaky one is the only way this feature can actually hurt anybody.
 */

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { competitionJoinUrl } from './joinUrl';
import { JoinQr, QrBoundary } from './JoinQr';

/** The value handed to the QR renderer, read back off the rendered SVG. */
function encodedUrl(): string {
  const svg = screen.getByRole('img');
  return svg.getAttribute('aria-label') ?? '';
}

describe('competitionJoinUrl', () => {
  it('addresses the public identity picker for that code', () => {
    expect(competitionJoinUrl('ZLMU88', 'https://example.test')).toBe(
      'https://example.test/compete/ZLMU88/join',
    );
  });

  it('lands on /join, not on the seat route', () => {
    // /compete/:code is the waiting room and expects a seat already held.
    // Sending a scanner there means an instant bounce to the picker at best.
    const url = competitionJoinUrl('ABC123', 'https://example.test');
    expect(url.endsWith('/join')).toBe(true);
  });

  it('follows the current origin rather than a hard-coded domain', () => {
    // A staging build must not send a room to production.
    expect(competitionJoinUrl('ABC123', 'https://staging.example.test')).toContain(
      'https://staging.example.test/',
    );
    expect(competitionJoinUrl('ABC123', 'http://localhost:5173')).toBe(
      'http://localhost:5173/compete/ABC123/join',
    );
  });

  it('defaults to the running application origin', () => {
    // jsdom serves http://localhost:3000 by default.
    expect(competitionJoinUrl('ABC123')).toBe(
      `${window.location.origin}/compete/ABC123/join`,
    );
  });

  it('changing the competition changes the destination', () => {
    const a = competitionJoinUrl('AAAAAA', 'https://example.test');
    const b = competitionJoinUrl('BBBBBB', 'https://example.test');
    expect(a).not.toBe(b);
    expect(b).toContain('BBBBBB');
    expect(b).not.toContain('AAAAAA');
  });

  it('matches the projected code, whatever case it arrives in', () => {
    expect(competitionJoinUrl('zlmu88', 'https://example.test')).toContain('/ZLMU88/');
  });

  it('tolerates a trailing slash on the origin', () => {
    expect(competitionJoinUrl('ABC123', 'https://example.test/')).toBe(
      'https://example.test/compete/ABC123/join',
    );
  });

  it('CARRIES NOTHING PRIVATE', () => {
    const url = competitionJoinUrl('ZLMU88', 'https://example.test');
    // No query string at all: nowhere for a credential to hide, and nothing
    // for a future caller to append "just one id" to.
    expect(url).not.toContain('?');
    expect(url).not.toContain('#');
    expect(url).not.toMatch(/token/i);
    expect(url).not.toMatch(/participant/i);
    expect(url).not.toMatch(/player/i);
    expect(url).not.toMatch(/jwt|bearer|auth/i);
    // The code is the ONLY competition identifier in it.
    expect(url).toBe('https://example.test/compete/ZLMU88/join');
  });
});

describe('<JoinQr>', () => {
  afterEach(() => vi.restoreAllMocks());

  it('encodes this competition, and says so accessibly', () => {
    render(<JoinQr code="ZLMU88" />);
    expect(encodedUrl()).toContain('ZLMU88');
  });

  it('renders an actual QR, not a placeholder', () => {
    const { container } = render(<JoinQr code="ZLMU88" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // A real matrix has many modules; a stub would not.
    expect(svg!.querySelectorAll('path, rect').length).toBeGreaterThan(0);
  });

  it('keeps the human instruction, so scanning is never the only way in', () => {
    render(<JoinQr code="ZLMU88" />);
    expect(screen.getByText(/scan or enter the code/i)).toBeInTheDocument();
  });

  it('renders nothing at all without a code', () => {
    const { container } = render(<JoinQr code="" />);
    expect(container.firstChild).toBeNull();
  });

  it('a QR failure must not take the lobby down with it', () => {
    // The join code, counters and roster are all still on screen and the room
    // works without this, so a broken renderer should cost the shortcut and
    // nothing else. A throw during render is why this is a boundary rather
    // than a try/catch.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Boom = (): never => {
      throw new Error('qr renderer exploded');
    };

    const { container } = render(
      <div data-testid="lobby">
        <span>JOIN CODE</span>
        <QrBoundary>
          <Boom />
        </QrBoundary>
      </div>,
    );

    // Survived, and the rest of the card is untouched.
    expect(screen.getByTestId('lobby')).toBeInTheDocument();
    expect(screen.getByText('JOIN CODE')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });
});
