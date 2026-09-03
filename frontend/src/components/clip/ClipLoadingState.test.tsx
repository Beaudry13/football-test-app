import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipPlayer } from './ClipPlayer';

/** A CLIP THAT IS STILL LOADING MUST SAY SO.
 *
 * REPORTED FROM A REAL PHONE: the recording worked, but there was roughly a
 * five second wait before it became playable, with nothing on screen to say
 * anything was happening. A player cannot tell a slow video from a broken one,
 * and PEIRA was showing them the same thing either way.
 *
 * Two separate things are covered here:
 *
 *   * the video asks for `preload="metadata"` - iOS defaults to `none` on a
 *     cellular connection, so nothing was fetched until the tap and the whole
 *     wait happened afterwards;
 *   * a visible loading state that clears on the browser's own readiness
 *     events and NEVER spins forever.
 */

let paused = true;
const original: Record<string, PropertyDescriptor | undefined> = {};

beforeEach(() => {
  vi.useFakeTimers();
  paused = true;
  for (const key of ['play', 'pause', 'paused', 'load'] as const) {
    original[key] = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, key);
  }
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    configurable: true,
    get: () => paused,
  });
  for (const [key, value] of [
    ['play', () => { paused = false; return Promise.resolve(); }],
    ['pause', () => { paused = true; }],
    ['load', () => {}],
  ] as const) {
    Object.defineProperty(HTMLMediaElement.prototype, key, {
      configurable: true,
      writable: true,
      value: vi.fn(value as () => unknown),
    });
  }
});

afterEach(() => {
  for (const key of ['play', 'pause', 'paused', 'load'] as const) {
    if (original[key]) Object.defineProperty(HTMLMediaElement.prototype, key, original[key]!);
    else delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>)[key];
  }
  vi.useRealTimers();
});

function renderClip(props: Record<string, unknown> = {}) {
  const { container } = render(
    <ClipPlayer url="/api/media/tok" posterUrl="/api/media/poster" {...props} />,
  );
  return { container, video: container.querySelector('video') as HTMLVideoElement };
}

describe('the wait is visible', () => {
  it('shows a loading state as soon as the question renders', () => {
    renderClip();
    expect(screen.getByText(/loading video/i)).toBeInTheDocument();
  });

  it('keeps the poster underneath, so the box never collapses or jumps', () => {
    const { video } = renderClip();
    expect(video.getAttribute('poster')).toBe('/api/media/poster');
  });

  it('asks the browser to start loading immediately', () => {
    // iOS defaults to `preload="none"` on cellular - the whole wait then
    // happens after the tap, which is what made this feel broken.
    const { video } = renderClip();
    expect(video.getAttribute('preload')).toBe('metadata');
  });

  it('does NOT ask for the whole file up front', () => {
    // A quiz can hold twenty clips; `auto` would spend a player's data on
    // football they may never reach.
    const { video } = renderClip();
    expect(video.getAttribute('preload')).not.toBe('auto');
  });

  it('clears once the browser says it has data', () => {
    const { video } = renderClip();
    act(() => {
      fireEvent.loadedData(video);
    });
    expect(screen.queryByText(/loading video/i)).toBeNull();
  });

  it('also clears on canplay, whichever the browser sends first', () => {
    const { video } = renderClip();
    act(() => {
      fireEvent.canPlay(video);
    });
    expect(screen.queryByText(/loading video/i)).toBeNull();
  });

  it('keeps the video source through the whole wait', () => {
    // The loading state must never be a second component that replaces the
    // player and drops its source.
    const { video } = renderClip();
    expect(video.getAttribute('src')).toBe('/api/media/tok');
    act(() => {
      fireEvent.loadedData(video);
    });
    expect(video.getAttribute('src')).toBe('/api/media/tok');
  });

  it('never covers the play surface', () => {
    // An overlay that ate the tap would replace a slow video with a dead one.
    const { container } = renderClip();
    const overlay = container.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(overlay.className).toMatch(/loading/i);
  });
});

describe('it never spins forever', () => {
  it('stops claiming to load and offers a retry', () => {
    renderClip();
    act(() => {
      vi.advanceTimersByTime(21000);
    });

    expect(screen.queryByText(/loading video/i)).toBeNull();
    expect(screen.getByText(/taking a while/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('retry starts the load again', () => {
    const { video } = renderClip();
    act(() => {
      vi.advanceTimersByTime(21000);
    });

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
    // Back to loading rather than stuck on the failure wording.
    expect(screen.getByText(/loading video/i)).toBeInTheDocument();
    expect(video.getAttribute('src')).toBe('/api/media/tok');
  });

  it('a clip that loads in time never shows the stalled message', () => {
    const { video } = renderClip();
    act(() => {
      fireEvent.loadedData(video);
    });
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(screen.queryByText(/taking a while/i)).toBeNull();
  });

  it('a real playback failure still falls back to the poster', () => {
    // The existing degradation is untouched: this is a different state from
    // "slow", and it must not be replaced by a spinner.
    const { container, video } = renderClip();
    act(() => {
      fireEvent.error(video);
    });
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByText(/could not play/i)).toBeInTheDocument();
    expect(screen.queryByText(/loading video/i)).toBeNull();
  });
});
