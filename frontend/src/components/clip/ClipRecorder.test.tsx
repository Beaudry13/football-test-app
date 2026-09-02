import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipRecorder } from './ClipRecorder';

/** CHOOSING A SOURCE IS NOT CONSENT TO RECORD.
 *
 * Record Clip originally started MediaRecorder on the same click that granted
 * the share, so the fifteen-second budget was spent arranging the window,
 * finding the right frame and moving the mouse out of shot. A coach cannot
 * arrange a window that is already recording.
 *
 * The separation is the behaviour, so it is the thing tested: that the picker
 * leaves the recorder untouched, that the clock does not start, and that a
 * share abandoned at READY is actually released rather than left running
 * behind a UI that has moved on.
 */

const MP4 = 'video/mp4;codecs="avc1.42E01E"';

class FakeTrack {
  stop = vi.fn();
  private listeners: Record<string, Array<() => void>> = {};
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  /** What the browser's own "Stop sharing" bar does. */
  endFromBrowser() {
    this.listeners.ended?.forEach((fn) => fn());
  }
}

class FakeStream {
  track = new FakeTrack();
  getTracks() {
    return [this.track];
  }
  getVideoTracks() {
    return [this.track];
  }
}

let recorders: FakeRecorder[] = [];

class FakeRecorder {
  static isTypeSupported = (mime: string) => mime === MP4;
  state = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start = vi.fn(() => {
    this.state = 'recording';
  });
  stop = vi.fn(() => {
    this.state = 'inactive';
    this.onstop?.();
  });
  stream: unknown;
  options: unknown;
  constructor(stream: unknown, options: unknown) {
    this.stream = stream;
    this.options = options;
    recorders.push(this);
  }
}

let stream: FakeStream;
let getDisplayMedia: ReturnType<typeof vi.fn>;
let original: { md: unknown; mr: unknown };

beforeEach(() => {
  vi.useFakeTimers();
  recorders = [];
  stream = new FakeStream();
  getDisplayMedia = vi.fn().mockResolvedValue(stream);
  original = {
    md: (navigator as unknown as { mediaDevices?: unknown }).mediaDevices,
    mr: (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder,
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia },
  });
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeRecorder;
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:clip');
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: original.md });
  (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = original.mr;
  vi.useRealTimers();
});

function setup() {
  const onUse = vi.fn();
  const onCancel = vi.fn();
  const { unmount } = render(<ClipRecorder onUse={onUse} onCancel={onCancel} />);
  return { onUse, onCancel, unmount };
}

/** `fireEvent`, not `userEvent`, throughout.
 *
 * userEvent schedules its own timers between events, and these tests run on
 * fake ones to reach the fifteen-second cap without waiting fifteen seconds.
 * Driving both from one test hung every case at the 5s limit. fireEvent
 * dispatches synchronously and needs no timer coordination at all, and the
 * behaviour under test here is a state machine rather than an input gesture,
 * so nothing of value is lost.
 */
function click(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

async function reachReady() {
  click(/choose what to record/i);
  // getDisplayMedia resolves on a microtask the click does not await.
  await act(async () => {});
}

describe('choosing a source', () => {
  it('does NOT begin recording', async () => {
    setup();
    await reachReady();

    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(recorders).toHaveLength(0);
    expect(screen.getByRole('button', { name: /^start recording$/i })).toBeInTheDocument();
  });

  it('never requests audio', async () => {
    setup();
    await reachReady();
    expect(getDisplayMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
  });

  it('shows a live preview and says the recording has not started', async () => {
    setup();
    await reachReady();

    expect(document.querySelector('video')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/nothing is being recorded yet/i);
  });

  it('leaves the timer at zero until Start is pressed', async () => {
    setup();
    await reachReady();

    // The clock is not merely showing 00 - it is not on screen at all, and no
    // amount of arranging the window starts it.
    act(() => void vi.advanceTimersByTime(30_000));
    expect(screen.queryByText(/recording ·/i)).toBeNull();
    expect(recorders).toHaveLength(0);
  });
});

describe('starting and stopping', () => {
  it('Start constructs and starts the recorder, on the share already granted', async () => {
    setup();
    await reachReady();
    click(/^start recording$/i);

    expect(recorders).toHaveLength(1);
    expect(recorders[0].start).toHaveBeenCalled();
    expect(recorders[0].stream).toBe(stream);
    // The picker is NOT shown a second time - the coach already chose.
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/recording · 00 \/ 15 sec/i)).toBeInTheDocument();
  });

  it('Stop stops the recorder', async () => {
    setup();
    await reachReady();
    click(/^start recording$/i);
    click(/^stop$/i);

    expect(recorders[0].stop).toHaveBeenCalled();
  });

  it('still auto-stops at fifteen seconds', async () => {
    setup();
    await reachReady();
    click(/^start recording$/i);

    act(() => void vi.advanceTimersByTime(14_000));
    expect(recorders[0].stop).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(1_500));
    expect(recorders[0].stop).toHaveBeenCalled();
  });

  it('counts the seconds only once recording has begun', async () => {
    setup();
    await reachReady();
    act(() => void vi.advanceTimersByTime(5_000));

    click(/^start recording$/i);
    act(() => void vi.advanceTimersByTime(3_000));

    // Three, not eight: the time spent arranging the window is not charged to
    // the clip.
    expect(screen.getByText(/recording · 03 \/ 15 sec/i)).toBeInTheDocument();
  });
});

describe('abandoning a share', () => {
  it('Cancel at READY releases the capture tracks', async () => {
    const { onCancel } = setup();
    await reachReady();
    click(/^cancel$/i);

    // The operating system must stop saying "sharing" the moment the UI does.
    expect(stream.track.stop).toHaveBeenCalled();
    // Back to the start rather than closed, so a different window can be
    // chosen without reopening the recorder.
    expect(screen.getByRole('button', { name: /choose what to record/i })).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('ending the share from the browser at READY returns to the start', async () => {
    setup();
    await reachReady();

    act(() => stream.track.endFromBrowser());

    expect(stream.track.stop).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /choose what to record/i })).toBeInTheDocument();
    expect(recorders).toHaveLength(0);
  });

  it('ending the share from the browser WHILE RECORDING stops the recorder', async () => {
    setup();
    await reachReady();
    click(/^start recording$/i);

    act(() => stream.track.endFromBrowser());

    // The take is kept, which is the behaviour that already existed.
    expect(recorders[0].stop).toHaveBeenCalled();
  });

  it('unmounting releases the tracks', async () => {
    const { unmount } = setup();
    await reachReady();
    expect(stream.track.stop).not.toHaveBeenCalled();

    unmount();

    // Closing the editor mid-share must not leave the coach's screen captured.
    expect(stream.track.stop).toHaveBeenCalled();
  });
});
