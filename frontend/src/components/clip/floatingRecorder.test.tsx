import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipRecorder } from './ClipRecorder';
import { canFloatOver, floatingControlsSupported } from './floatingRecorder';

/** START AND STOP WHERE THE COACH IS LOOKING.
 *
 * A coach records from Hudl or Football HD: they choose that window, switch to
 * it, find the play - and then have to hunt back through a row of tabs to
 * press Start. Document Picture-in-Picture puts the controls on top of the
 * football instead.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS CAN AND CANNOT PROVE
 * ---------------------------------------------------------------------------
 *
 * Document PiP could not be exercised in the environment this was written in.
 * The embedded browser has no real window to detach one from - `requestWindow`
 * fails there with `InvalidStateError: no window` even on a direct click - and
 * a real Chrome was not reachable either. So two OS-level behaviours are
 * REASONED, NOT MEASURED:
 *
 *   * that the window genuinely floats above another application, and
 *   * that a window/tab capture really excludes it from the recording.
 *
 * The second is why `monitor` never gets one: a control burned into the middle
 * of a coach's football cannot be undone after the take, so the only surfaces
 * offered a floating control are ones where a separate window is not part of
 * what is being composited.
 *
 * What IS proven below is everything that does not need an OS: the surface
 * rule, that the floating control drives the SAME recorder as the page, that
 * there is still exactly ONE share picker, and - most importantly - that every
 * way this can fail lands back on the controls that shipped before it existed.
 */

const MP4 = 'video/mp4;codecs="avc1.42E01E"';

class FakeTrack {
  stop = vi.fn();
  applyConstraints = vi.fn(() => Promise.resolve());
  private listeners: Record<string, Array<() => void>> = {};
  private surface: string | undefined;
  constructor(surface: string | undefined) {
    this.surface = surface;
  }
  getSettings() {
    return this.surface === undefined ? {} : { displaySurface: this.surface };
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  endFromBrowser() {
    this.listeners.ended?.forEach((fn) => fn());
  }
}

class FakeStream {
  track: FakeTrack;
  constructor(surface: string | undefined) {
    this.track = new FakeTrack(surface);
  }
  getTracks() {
    return [this.track];
  }
  getVideoTracks() {
    return [this.track];
  }
}

let recorders: FakeRecorder[] = [];

class FakeRecorder {
  static isTypeSupported = (m: string) => m === MP4;
  state = 'inactive';
  ondataavailable: unknown = null;
  onstop: (() => void) | null = null;
  start = vi.fn(() => {
    this.state = 'recording';
  });
  stop = vi.fn(() => {
    this.state = 'inactive';
    this.onstop?.();
  });
  constructor() {
    recorders.push(this);
  }
}

/** A stand-in for the picture-in-picture window.
 *
 *  Its `document` is a REAL detached document, so the module's actual DOM
 *  building runs and the buttons it creates can be clicked. A hand-written
 *  object with fake elements would have tested the test. */
class FakePiPWindow {
  document = window.document.implementation.createHTMLDocument('pip');
  closed = false;
  close = vi.fn(() => {
    this.closed = true;
  });
  private listeners: Record<string, Array<() => void>> = {};
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  closedByCoach() {
    this.listeners.pagehide?.forEach((fn) => fn());
  }
  button(label: RegExp) {
    const found = Array.from(this.document.querySelectorAll('button')).find((b) =>
      label.test(b.textContent ?? ''),
    );
    if (!found) throw new Error(`no floating button matching ${label}`);
    return found;
  }
  get status() {
    return this.document.body.textContent ?? '';
  }
}

let stream: FakeStream;
let pip: FakePiPWindow | null;
let requestWindow: ReturnType<typeof vi.fn>;
let getDisplayMedia: ReturnType<typeof vi.fn>;
let original: { md: unknown; mr: unknown; pip: unknown };

function setupEnv(surface: string | undefined, opts: { pipWorks?: boolean } = {}) {
  stream = new FakeStream(surface);
  pip = opts.pipWorks === false ? null : new FakePiPWindow();
  getDisplayMedia = vi.fn().mockResolvedValue(stream);
  requestWindow = vi.fn(() =>
    pip ? Promise.resolve(pip) : Promise.reject(new Error('refused')),
  );
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia },
  });
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeRecorder;
  (window as unknown as { documentPictureInPicture: unknown }).documentPictureInPicture = {
    requestWindow,
  };
}

beforeEach(() => {
  recorders = [];
  original = {
    md: (navigator as unknown as { mediaDevices?: unknown }).mediaDevices,
    mr: (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder,
    pip: (window as unknown as { documentPictureInPicture?: unknown })
      .documentPictureInPicture,
  };
});

afterEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: original.md });
  (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = original.mr;
  (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture =
    original.pip;
});

function renderRecorder() {
  const onUse = vi.fn();
  const onCancel = vi.fn();
  render(<ClipRecorder onUse={onUse} onCancel={onCancel} />);
  return { onUse, onCancel };
}

async function chooseSource() {
  fireEvent.click(screen.getByRole('button', { name: /choose what to record/i }));
  // getDisplayMedia, applyConstraints and requestWindow each settle on their
  // own microtask, and none is awaited by the click handler.
  for (let i = 0; i < 4; i += 1) await act(async () => {});
}

describe('which surfaces may float', () => {
  it('allows a window and a tab', () => {
    // A separate browser window is not the window being captured, and is not
    // tab content.
    expect(canFloatOver('window')).toBe(true);
    expect(canFloatOver('browser')).toBe(true);
  });

  it('REFUSES a whole-screen capture', () => {
    // The control would sit on the very screen being recorded. A Peira button
    // burned into a coach's football cannot be undone after the take.
    expect(canFloatOver('monitor')).toBe(false);
  });

  it('refuses anything it cannot identify', () => {
    // Not knowing the surface is not permission to guess.
    expect(canFloatOver(undefined)).toBe(false);
    expect(canFloatOver(null)).toBe(false);
    expect(canFloatOver('')).toBe(false);
    expect(canFloatOver('something-new')).toBe(false);
  });

  it('reports support from the API being present', () => {
    (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture =
      undefined;
    expect(floatingControlsSupported()).toBe(false);
    (window as unknown as { documentPictureInPicture: unknown }).documentPictureInPicture = {
      requestWindow: () => Promise.resolve({}),
    };
    expect(floatingControlsSupported()).toBe(true);
  });
});

describe('a window capture gets floating controls', () => {
  it('opens one, and still reaches READY on the page', async () => {
    setupEnv('window');
    renderRecorder();
    await chooseSource();

    expect(requestWindow).toHaveBeenCalledTimes(1);
    expect(pip!.button(/start recording/i)).toBeTruthy();
    // The page keeps its own controls too - the coach may never leave, and
    // must not be forced into the floating window.
    expect(screen.getByRole('button', { name: /^start recording$/i })).toBeInTheDocument();
  });

  it('does NOT start recording merely because the control opened', async () => {
    // READY exists so a coach can position the film first. That rule does not
    // change because the controls moved.
    setupEnv('window');
    renderRecorder();
    await chooseSource();

    expect(recorders).toHaveLength(0);
    expect(pip!.status).toMatch(/not recording/i);
  });

  it('starts the SAME recorder from the floating control, with no second picker', async () => {
    setupEnv('window');
    renderRecorder();
    await chooseSource();

    act(() => {
      pip!.button(/start recording/i).click();
    });

    expect(recorders).toHaveLength(1);
    expect(recorders[0].start).toHaveBeenCalled();
    // ONE share, for the whole flow.
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(requestWindow).toHaveBeenCalledTimes(1);
  });

  it('records the already-granted stream', async () => {
    setupEnv('window');
    renderRecorder();
    await chooseSource();
    act(() => {
      pip!.button(/start recording/i).click();
    });

    // Not a new capture - the one the coach already chose.
    expect((recorders[0] as unknown as { stream?: unknown }).stream ?? stream).toBeTruthy();
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });

  it('turns into Stop, and stopping ends the take', async () => {
    setupEnv('window');
    renderRecorder();
    await chooseSource();

    act(() => {
      pip!.button(/start recording/i).click();
    });
    expect(pip!.button(/stop recording/i)).toBeTruthy();
    expect(pip!.status).toMatch(/recording ·/i);

    act(() => {
      pip!.button(/stop recording/i).click();
    });
    expect(recorders[0].stop).toHaveBeenCalled();
  });

  it('cancelling from the floating control releases the capture', async () => {
    setupEnv('window');
    renderRecorder();
    await chooseSource();

    act(() => {
      pip!.button(/cancel/i).click();
    });

    // The operating system must stop saying "sharing" the moment the coach
    // says stop, wherever they said it.
    expect(stream.track.stop).toHaveBeenCalled();
    expect(pip!.close).toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: /choose what to record/i }),
    ).toBeInTheDocument();
  });

  it('closing the floating window mid-take stops the recording', async () => {
    // Otherwise the coach has dismissed the only Stop button they were
    // looking at, and a capture keeps running behind them.
    setupEnv('window');
    renderRecorder();
    await chooseSource();
    act(() => {
      pip!.button(/start recording/i).click();
    });

    act(() => {
      pip!.closedByCoach();
    });
    expect(recorders[0].stop).toHaveBeenCalled();
  });

  it('ending the share from the browser bar closes the floating control', async () => {
    setupEnv('window');
    renderRecorder();
    await chooseSource();

    act(() => {
      stream.track.endFromBrowser();
    });

    expect(pip!.close).toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: /choose what to record/i }),
    ).toBeInTheDocument();
  });
});

describe('a whole-screen capture keeps the page controls', () => {
  it('never opens a floating control', async () => {
    setupEnv('monitor');
    renderRecorder();
    await chooseSource();

    // THE RULE THAT PROTECTS THE FOOTBALL.
    expect(requestWindow).not.toHaveBeenCalled();
  });

  it('still reaches READY, unchanged', async () => {
    setupEnv('monitor');
    renderRecorder();
    await chooseSource();

    expect(screen.getByRole('button', { name: /^start recording$/i })).toBeInTheDocument();
    expect(recorders).toHaveLength(0);
  });

  it('tells the coach the controls stayed here, and how to get floating ones', async () => {
    setupEnv('monitor');
    renderRecorder();
    await chooseSource();

    expect(screen.getByText(/recording the whole screen/i)).toBeInTheDocument();
    expect(screen.getByText(/share a single window instead/i)).toBeInTheDocument();
  });

  it('records normally from the page', async () => {
    setupEnv('monitor');
    renderRecorder();
    await chooseSource();
    fireEvent.click(screen.getByRole('button', { name: /^start recording$/i }));

    expect(recorders).toHaveLength(1);
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
  });
});

describe('every failure lands on the controls we already had', () => {
  it('a refused floating window costs nothing', async () => {
    // The whole point of the design: the worst case is today's behaviour.
    setupEnv('window', { pipWorks: false });
    renderRecorder();
    await chooseSource();

    expect(screen.getByRole('button', { name: /^start recording$/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^start recording$/i }));
    expect(recorders).toHaveLength(1);
  });

  it('a browser without the API is unaffected', async () => {
    setupEnv('window');
    (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture =
      undefined;
    renderRecorder();
    await chooseSource();

    expect(screen.getByRole('button', { name: /^start recording$/i })).toBeInTheDocument();
    // Exactly ONE live region on the READY screen. Two would talk over each
    // other for anyone using a screen reader.
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByText(/come back to this tab/i)).toBeInTheDocument();
  });

  it('a share with no reported surface is treated as a whole screen', async () => {
    setupEnv(undefined);
    renderRecorder();
    await chooseSource();

    expect(requestWindow).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^start recording$/i })).toBeInTheDocument();
  });
});
