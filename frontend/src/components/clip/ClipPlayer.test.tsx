import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
