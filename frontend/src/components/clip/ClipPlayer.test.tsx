import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipPlayer, ClipThumbnail } from './ClipPlayer';

/** The four playback attributes are load-bearing and none is optional.
 *
 * `muted` missing => autoplay blocked on every browser.
 * `playsinline` missing => iOS takes the clip fullscreen mid-quiz.
 *
 * Both failures happen only on real devices, and a test that merely asserted
 * "a <video> rendered" would pass through either one. That is why each
 * attribute is checked by name.
 */
describe('ClipPlayer', () => {
  function renderClip(props = {}) {
    const { container } = render(
      <ClipPlayer url="/api/media/tok" posterUrl="/api/media/poster" {...props} />,
    );
    return container.querySelector('video') as HTMLVideoElement;
  }

  it('renders a video with all four GIF-like attributes', () => {
    const video = renderClip();
    expect(video).toBeTruthy();
    expect(video.hasAttribute('autoplay')).toBe(true);
    expect(video.hasAttribute('loop')).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    // React reflects `muted` as a property rather than an attribute.
    expect(video.muted).toBe(true);
  });

  it('shows no controls', () => {
    // A fifteen-second silent loop has nothing to control, and a scrubber
    // would invite a player to treat it as a video rather than as the
    // material the question is about.
    expect(renderClip().hasAttribute('controls')).toBe(false);
  });

  it('carries the poster so the first paint is never blank', () => {
    expect(renderClip().getAttribute('poster')).toBe('/api/media/poster');
  });

  it('falls back to the poster and says so when the clip cannot play', () => {
    const { container } = render(
      <ClipPlayer url="/api/media/broken" posterUrl="/api/media/poster" />,
    );
    // fireEvent, not dispatchEvent: a media `error` does not bubble, so a
    // raw dispatch never reaches React's synthetic handler.
    fireEvent.error(container.querySelector('video') as HTMLVideoElement);

    // Not a blank rectangle: the still is real football material, and the
    // note is explicit that the motion is missing rather than implying the
    // question is broken.
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByRole('img')).toHaveAttribute('src', '/api/media/poster');
    expect(screen.getByText(/could not play/i)).toBeInTheDocument();
  });

  it('degrades to a bare message when there is no poster either', () => {
    const { container } = render(<ClipPlayer url="/api/media/broken" posterUrl={null} />);
    fireEvent.error(container.querySelector('video') as HTMLVideoElement);
    expect(screen.getByText(/could not play/i)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('ClipThumbnail', () => {
  it('renders the still, never a looping video', () => {
    // A question list can hold twenty questions; twenty simultaneous loops is
    // real decoding work for a surface that is scanned rather than watched.
    const { container } = render(<ClipThumbnail posterUrl="/api/media/poster" alt="Still" />);
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByRole('img')).toHaveAttribute('src', '/api/media/poster');
  });

  it('renders nothing without a poster', () => {
    const { container } = render(<ClipThumbnail posterUrl={null} />);
    expect(container.firstChild).toBeNull();
  });
});

/** ONE TAP, BECAUSE A PAUSED CLIP USED TO BE A DEAD END.
 *
 * `controls={false}` with no handler meant a clip that paused for reasons the
 * player did not choose - iOS blocking muted autoplay in Low Power Mode, or
 * Safari pausing a backgrounded tab and not resuming - left a frozen frame
 * with no affordance of any kind.
 *
 * jsdom implements neither `play()` nor `pause()`, so both are stubbed here
 * along with a writable `paused`. The stubs are RESTORED afterwards: the one
 * un-restored prototype mutation in this suite is already a known cause of
 * order-dependent noise, and there is no reason to add a second.
 */
describe('ClipPlayer playback control', () => {
  let paused = false;
  let playResult: () => Promise<void>;
  const original: Record<string, PropertyDescriptor | undefined> = {};

  beforeEach(() => {
    paused = false;
    playResult = () => Promise.resolve();
    for (const key of ['play', 'pause', 'paused'] as const) {
      original[key] = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, key);
    }
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
      configurable: true,
      get: () => paused,
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      writable: true,
      value: vi.fn(() => {
        const result = playResult();
        return result.then(
          () => {
            paused = false;
          },
          (err) => {
            paused = true;
            throw err;
          },
        );
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
    for (const key of ['play', 'pause', 'paused'] as const) {
      if (original[key]) {
        Object.defineProperty(HTMLMediaElement.prototype, key, original[key]!);
      } else {
        delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>)[key];
      }
    }
  });

  function renderClip() {
    const { container } = render(
      <ClipPlayer url="/api/media/tok" posterUrl="/api/media/poster" />,
    );
    return {
      container,
      video: container.querySelector('video') as HTMLVideoElement,
      button: screen.getByRole('button'),
    };
  }

  it('still autoplays, loops natively, stays muted and inline', () => {
    const { video } = renderClip();
    expect(video.hasAttribute('autoplay')).toBe(true);
    // NATIVE loop, not a scripted one - nothing here may replace it.
    expect(video.hasAttribute('loop')).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.hasAttribute('controls')).toBe(false);
  });

  it('asks the browser to play on mount', () => {
    renderClip();
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it('pauses on tap while playing', () => {
    const { button, video } = renderClip();
    fireEvent.click(button);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    fireEvent.pause(video);
    expect(screen.getByRole('button', { name: /play the clip/i })).toBeInTheDocument();
  });

  it('resumes on a second tap', () => {
    const { button, video } = renderClip();
    fireEvent.click(button);
    fireEvent.pause(video);

    (HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.click(button);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    fireEvent.play(video);
    expect(screen.getByRole('button', { name: /pause the clip/i })).toBeInTheDocument();
  });

  it('repeated taps follow the element, not a stale copy of React state', () => {
    const { button, video } = renderClip();
    for (let i = 0; i < 3; i += 1) {
      fireEvent.click(button);
      fireEvent.pause(video);
      fireEvent.click(button);
      fireEvent.play(video);
    }
    expect(screen.getByRole('button', { name: /pause the clip/i })).toBeInTheDocument();
  });

  it('recovers when autoplay is BLOCKED, which is the whole point', async () => {
    // Low Power Mode on iOS. play() rejects, nothing was listening, and the
    // player was left looking at a still with no way to start it.
    playResult = () => Promise.reject(new Error('NotAllowedError'));
    const { button, video } = renderClip();
    await Promise.resolve();
    await Promise.resolve();

    expect(await screen.findByRole('button', { name: /play the clip/i })).toBeInTheDocument();

    playResult = () => Promise.resolve();
    fireEvent.click(button);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(2);
    fireEvent.play(video);
    expect(screen.getByRole('button', { name: /pause the clip/i })).toBeInTheDocument();
  });

  it('offers the same recovery after a backgrounded tab returns paused', () => {
    const { video } = renderClip();
    // Safari pauses a backgrounded video and does not resume it on return.
    fireEvent.pause(video);
    expect(screen.getByRole('button', { name: /play the clip/i })).toBeInTheDocument();
  });

  it('is a real button, so a keyboard can reach it', () => {
    // A <video> without controls is not focusable at all - a bare onClick
    // would have made this mouse-and-touch only.
    const { button } = renderClip();
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAccessibleName();
  });

  it('names the clip once, not twice', () => {
    // The button carries the accessible name; announcing the video separately
    // would read the same clip to a screen reader twice.
    const { video } = renderClip();
    expect(video).toHaveAttribute('aria-hidden', 'true');
  });

  it('still degrades to the poster when playback fails outright', () => {
    const { container, video } = renderClip();
    fireEvent.error(video);
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByRole('img')).toHaveAttribute('src', '/api/media/poster');
    expect(screen.getByText(/could not play/i)).toBeInTheDocument();
  });
});
