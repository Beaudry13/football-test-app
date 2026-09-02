import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipPlayer } from './ClipPlayer';
import { decisionPointSeconds } from './decisionPoint';

/** THE VIDEO MUST NOT RUN THROUGH THE DECISION POINT.
 *
 * Football recognition is tested before the outcome exists, so a clip that
 * plays on to the whistle answers its own question. Everything here defends
 * that one sentence.
 *
 * Real-device evidence behind the mechanism (Phase 0, 2 Sep 2026): on an
 * iPhone, 10/10 attempts stopped in time with a MAXIMUM overshoot of 41ms,
 * against a 100ms maximum threshold. That is the only device evidence we have
 * and no broader guarantee is claimed.
 *
 * The same harness found the failure that shaped the code: rVFC and rAF are
 * both display-driven, and in a tab that was not being composited NEITHER
 * fired while the clip played to its end. `timeupdate` and a timer are the
 * floor beneath them, and the tests below drive that floor directly - jsdom
 * presents no frames, so rVFC and rAF cannot fire here either, which makes
 * this an honest test of the backstop rather than a contrived one.
 */

let paused = true;
let currentTime = 0;
const original: Record<string, PropertyDescriptor | undefined> = {};

beforeEach(() => {
  paused = true;
  currentTime = 0;
  for (const key of ['play', 'pause', 'paused', 'currentTime'] as const) {
    original[key] = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, key);
  }
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get: () => paused,
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
    configurable: true,
    get: () => currentTime,
    set: (v: number) => {
      currentTime = v;
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    writable: true,
    value: vi.fn(() => {
      paused = false;
      return Promise.resolve();
    }),
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    writable: true,
    value: vi.fn(() => {
      paused = true;
    }),
  });
});

afterEach(() => {
  for (const key of ['play', 'pause', 'paused', 'currentTime'] as const) {
    if (original[key]) Object.defineProperty(HTMLMediaElement.prototype, key, original[key]!);
    else delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>)[key];
  }
});

function renderClip(props: Record<string, unknown> = {}) {
  const { container } = render(
    <ClipPlayer url="/api/media/tok" posterUrl="/api/media/poster" {...props} />,
  );
  return { container, video: container.querySelector('video') as HTMLVideoElement };
}

/** Advances the film and fires the media-pipeline event a real browser would.
 *  Not a shortcut: `timeupdate` is the mechanism that has to work when nothing
 *  is being painted. */
function advanceTo(video: HTMLVideoElement, seconds: number) {
  act(() => {
    currentTime = seconds;
    fireEvent.timeUpdate(video);
  });
}

describe('an ordinary clip is untouched', () => {
  it('still loops natively and autoplays', () => {
    const { video } = renderClip();
    expect(video.hasAttribute('loop')).toBe(true);
    expect(video.hasAttribute('autoplay')).toBe(true);
    expect(screen.queryByRole('button', { name: /replay/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /see the rest/i })).toBeNull();
  });

  it('shows no decision-point copy', () => {
    renderClip();
    expect(screen.queryByText(/the film stops here/i)).toBeNull();
  });
});

describe('a decision-point clip', () => {
  it('does NOT loop the whole play', () => {
    // Native loop would carry the player straight past the decision point.
    const { video } = renderClip({ decisionPointMs: 6000 });
    expect(video.hasAttribute('loop')).toBe(false);
  });

  it('stops when the film reaches the decision point', () => {
    const { video } = renderClip({ decisionPointMs: 6000 });
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();

    advanceTo(video, 6.0);

    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(paused).toBe(true);
  });

  it('does not stop early', () => {
    const { video } = renderClip({ decisionPointMs: 6000 });
    advanceTo(video, 4.5);
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
  });

  it('seeks back when a stop lands late, so the coach frame is what is held', () => {
    // The self-correction. A late stop still shows the frame that was chosen.
    const { video } = renderClip({ decisionPointMs: 6000 });
    advanceTo(video, 6.4);
    expect(currentTime).toBeCloseTo(6.0, 5);
  });

  it('tells the player why the film stopped', () => {
    renderClip({ decisionPointMs: 6000 });
    expect(screen.getByText(/the film stops here/i)).toBeInTheDocument();
  });
});

describe('replay', () => {
  it('returns to the beginning and stops at the same point again', () => {
    const { video } = renderClip({ decisionPointMs: 6000 });
    advanceTo(video, 6.0);
    (HTMLMediaElement.prototype.pause as ReturnType<typeof vi.fn>).mockClear();

    fireEvent.click(screen.getByRole('button', { name: /replay/i }));
    expect(currentTime).toBe(0);
    expect(paused).toBe(false);

    advanceTo(video, 6.0);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it('a tap on a held clip restarts the run-up rather than playing on', () => {
    // A TAP MUST NEVER BE A WAY PAST THE DECISION POINT.
    const { video } = renderClip({ decisionPointMs: 6000 });
    advanceTo(video, 6.0);

    fireEvent.click(screen.getByRole('button', { name: /play the clip|pause the clip/i }));
    expect(currentTime).toBe(0);
  });
});

describe('see the rest', () => {
  it('is not offered before an answer exists', () => {
    const { video } = renderClip({ decisionPointMs: 6000, canReveal: false });
    advanceTo(video, 6.0);
    expect(screen.queryByRole('button', { name: /see the rest/i })).toBeNull();
  });

  it('is offered once an answer exists', () => {
    const { video } = renderClip({ decisionPointMs: 6000, canReveal: true });
    advanceTo(video, 6.0);
    expect(screen.getByRole('button', { name: /see the rest/i })).toBeInTheDocument();
  });

  it('resumes from the decision point and is not stopped again', () => {
    const { video } = renderClip({ decisionPointMs: 6000, canReveal: true });
    advanceTo(video, 6.0);

    fireEvent.click(screen.getByRole('button', { name: /see the rest/i }));
    expect(currentTime).toBeCloseTo(6.0, 5);
    expect(paused).toBe(false);

    (HTMLMediaElement.prototype.pause as ReturnType<typeof vi.fn>).mockClear();
    // Past the decision point, the film must now keep going to the end.
    advanceTo(video, 8.0);
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();
    expect(currentTime).toBe(8.0);
  });

  it('says nothing about whether the answer was right', () => {
    // Revealing the play is NOT revealing the answer. The component is given
    // no correctness signal, so it cannot leak one.
    const { container, video } = renderClip({ decisionPointMs: 6000, canReveal: true });
    advanceTo(video, 6.0);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/correct|incorrect|right|wrong/i);
  });
});

describe('a single-page quiz', () => {
  it('does not start on its own', () => {
    // Twenty clips playing at once is a wall of film on a page a player is
    // still reading.
    renderClip({ decisionPointMs: 6000, autostart: false });
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('drops the autoplay attribute too', () => {
    const { video } = renderClip({ autostart: false });
    expect(video.hasAttribute('autoplay')).toBe(false);
  });
});

describe('decisionPointSeconds', () => {
  it('treats absent, zero and nonsense as an ordinary clip', () => {
    // Presentation must never fail into an error screen when the honest answer
    // is "this one just loops".
    expect(decisionPointSeconds(null)).toBeNull();
    expect(decisionPointSeconds(undefined)).toBeNull();
    expect(decisionPointSeconds(0)).toBeNull();
    expect(decisionPointSeconds(-500)).toBeNull();
    expect(decisionPointSeconds(Number.NaN)).toBeNull();
  });

  it('converts milliseconds to seconds', () => {
    expect(decisionPointSeconds(6000)).toBe(6);
    expect(decisionPointSeconds(4250)).toBe(4.25);
  });
});
