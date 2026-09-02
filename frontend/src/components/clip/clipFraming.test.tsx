import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipPlayer } from './ClipPlayer';

/** THE FULL FOOTBALL FRAME, FROM ITS TRUE ORIGIN.
 *
 * PEIRA has had this bug class before: the bottom-right of a picture ends up
 * drawn in the top-left of its container, or only one quadrant survives. It
 * comes from mixed coordinate spaces - an origin offset, a stray transform, or
 * a full-size surface quietly inheriting a thumbnail's crop.
 *
 * ---------------------------------------------------------------------------
 * WHAT JSDOM CANNOT DO, SAID PLAINLY
 * ---------------------------------------------------------------------------
 *
 * jsdom has NO LAYOUT ENGINE. `getBoundingClientRect` returns zeros, CSS
 * modules resolve to opaque identifiers, and no stylesheet is ever applied. A
 * test here CANNOT prove that a frame is drawn from its true origin, and any
 * test claiming to would be measuring nothing.
 *
 * So the real geometry was measured in a REAL BROWSER instead, against the
 * shipped rules, and recorded here (2 Sep 2026, Chromium, 900x1000 viewport):
 *
 *   landscape 1280x720   box ratio 1.7778 vs intrinsic 1.7778  (exact)
 *                        origin delta 0,0   overflow right 0
 *   portrait  720x1280   clamped by max-height to 640x820, content letterboxed
 *                        by `contain` - whole frame visible, origin delta 0,0
 *   thumbnail            `cover`, 108x72 - the one intentional crop
 *
 *   and across play -> freeze (pause + corrective seek) -> replay -> reveal,
 *   the element rect was IDENTICAL every time: [12, 38, 640, 360].
 *
 * Re-measuring that needs a browser and is not automated. What IS automated
 * below are the structural invariants that would have to break FIRST for the
 * bug to come back - the class contract and the element contract.
 */

const cssPath = (name: string) =>
  fileURLToPath(new URL(name, import.meta.url));

const clipCss = readFileSync(cssPath('./ClipPlayer.module.css'), 'utf8');
const editorCss = readFileSync(cssPath('./DecisionPointEditor.module.css'), 'utf8');
const recorderCss = readFileSync(cssPath('./ClipRecorder.module.css'), 'utf8');
const listCss = readFileSync(
  cssPath('../../pages/quiz-editor/QuestionsTab.module.css'),
  'utf8',
);
const playCss = readFileSync(cssPath('../../pages/play/PlayPage.module.css'), 'utf8');

/** The declarations inside one rule, by class name. Crude on purpose: reading
 *  the stylesheet as text is the only way to assert a CSS contract from a test
 *  runner that never applies CSS. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(selector + ' {');
  if (at === -1) throw new Error(`no rule for ${selector}`);
  // Comments stripped first. These files explain their reasoning at length,
  // and a rule whose COMMENT says "no overflow here" would otherwise read as
  // a rule that sets overflow.
  return css.slice(at, css.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('the full-view media surfaces present the whole frame', () => {
  it.each([
    ['ClipPlayer .clip', clipCss, '.clip'],
    ['ClipPlayer .fallback', clipCss, '.fallback'],
    ['DecisionPointEditor .video', editorCss, '.video'],
    ['ClipRecorder .preview', recorderCss, '.preview'],
    ['player question media', playCss, '.questionImage'],
  ])('%s uses object-fit: contain, never cover', (_name, css, selector) => {
    const body = ruleBody(css, selector);
    expect(body).toContain('object-fit: contain');
    expect(body).not.toContain('cover');
  });

  it('no full-view surface repositions or transforms the frame', () => {
    // `object-position` and `transform` are how a frame gets moved off its
    // origin. The play badge is allowed a transform; the media is not.
    for (const [css, selector] of [
      [clipCss, '.clip'],
      [editorCss, '.video'],
      [recorderCss, '.preview'],
      [playCss, '.questionImage'],
    ] as const) {
      const body = ruleBody(css, selector);
      expect(body).not.toContain('object-position');
      expect(body).not.toContain('transform');
      expect(body).not.toMatch(/margin[^;]*:\s*-/);
    }
  });

  it('the one cropping rule is the thumbnail, and it is scoped to thumbnails', () => {
    // A thumbnail may crop on purpose. Nothing else may, and this is the line
    // that has to stay true.
    expect(ruleBody(listCss, '.thumb')).toContain('object-fit: cover');
    expect(ruleBody(listCss, '.thumbPage')).toContain('object-fit: contain');
    // `cover` appears nowhere in any surface that shows a clip full size.
    for (const css of [clipCss, editorCss, recorderCss]) {
      expect(css).not.toContain('object-fit: cover');
    }
  });

  it('the play surface does not clip what the video draws', () => {
    // `overflow: hidden` on the wrapper plus a max-height on the video is
    // exactly how a tall clip gets cropped instead of letterboxed. It was
    // there once and was removed for this reason.
    expect(ruleBody(clipCss, '.surface')).not.toContain('overflow');
  });
});

describe('only playback state changes at the freeze', () => {
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

  function advanceTo(video: HTMLVideoElement, seconds: number) {
    act(() => {
      currentTime = seconds;
      fireEvent.timeUpdate(video);
    });
  }

  it('keeps the SAME element, with the same classes, through freeze, replay and reveal', () => {
    // The browser measurement above showed an identical rect at every stage.
    // What jsdom can hold down is the reason that was true: the component
    // never swaps the element or restyles it - it only changes time and
    // paused state. A future refactor that re-created the video, or added a
    // class at the freeze, is exactly how the framing would start moving.
    const { container } = render(
      <ClipPlayer
        url="/api/media/tok"
        posterUrl="/api/media/poster"
        decisionPointMs={6000}
        canReveal
      />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    const initialClass = video.className;

    advanceTo(video, 6.0);
    expect(container.querySelector('video')).toBe(video);
    expect(video.className).toBe(initialClass);

    fireEvent.click(screen.getByRole('button', { name: /replay/i }));
    expect(container.querySelector('video')).toBe(video);
    expect(video.className).toBe(initialClass);

    advanceTo(video, 6.0);
    fireEvent.click(screen.getByRole('button', { name: /see the rest/i }));
    expect(container.querySelector('video')).toBe(video);
    expect(video.className).toBe(initialClass);
  });

  it('never sizes the media with inline styles or width/height attributes', () => {
    // Stored clip width/height are upload metadata. If they ever started
    // sizing the box, a clip recorded with zeroed dimensions - which
    // capturePoster can produce on failure - would collapse or misframe.
    const { container } = render(
      <ClipPlayer url="/api/media/tok" posterUrl="/api/media/poster" decisionPointMs={6000} />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('style')).toBeNull();
    expect(video.getAttribute('width')).toBeNull();
    expect(video.getAttribute('height')).toBeNull();
  });

  it('gives the poster and the video the same element, so they share one box', () => {
    // The poster is drawn by the UA inside this element under the same
    // object-fit. It is captured at videoWidth/videoHeight, so its ratio
    // matches the video's and there is no geometry jump when decoding starts.
    const { container } = render(
      <ClipPlayer url="/api/media/tok" posterUrl="/api/media/poster" />,
    );
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('poster')).toBe('/api/media/poster');
    expect(container.querySelectorAll('video')).toHaveLength(1);
    expect(container.querySelector('img')).toBeNull();
  });
});
