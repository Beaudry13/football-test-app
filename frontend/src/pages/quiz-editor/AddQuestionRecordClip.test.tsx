import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QuestionEditor } from './QuestionEditor';

/** ADD QUESTION -> RECORD CLIP -> CHOOSE WHAT TO RECORD -> READY.
 *
 * THE PRODUCTION BUG THIS GUARDS (found in normal use, 2 Sep 2026):
 * the browser picker opened, the coach chose a window, and the recorder stayed
 * on its opening screen. No live preview, no Start recording, no error - the
 * click simply appeared to do nothing.
 *
 * Two defects, both real:
 *
 *  1. `getDisplayMedia` was being asked for `width: { max: 1920 }` and
 *     `height: { max: 1080 }`. Those were added on the reasoning that a
 *     maximum can only downscale and so cannot fail. In production the call
 *     REJECTED after the source was chosen. The cap now goes on the track
 *     AFTER the grant, where failing costs resolution instead of the feature.
 *
 *  2. The rejection was swallowed. `NotAllowedError` and `AbortError` were
 *     treated as "the coach cancelled the picker" - which they usually are,
 *     but they are also what a refusal looks like, and the two are not
 *     reliably distinguishable. So the coach was shown nothing at all.
 *
 * This exercises the ADD QUESTION integration rather than ClipRecorder alone,
 * because the report was specific to that path and a component test in
 * isolation would not have caught an integration remount.
 */

const MP4 = 'video/mp4;codecs="avc1.42E01E"';

vi.mock('../../api/questions', () => ({
  createQuestion: vi.fn(),
  updateQuestion: vi.fn(),
  deleteQuestion: vi.fn(),
  reorderQuestions: vi.fn(),
  retireQuestion: vi.fn(),
  restoreQuestion: vi.fn(),
  uploadQuestionClip: vi.fn(),
  deleteQuestionClip: vi.fn(),
  setClipDecisionPoint: vi.fn(),
}));

class FakeTrack {
  stop = vi.fn();
  applyConstraints = vi.fn(() => Promise.resolve());
  addEventListener = vi.fn();
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
  static isTypeSupported = (m: string) => m === MP4;
  state = 'inactive';
  ondataavailable: unknown = null;
  onstop: unknown = null;
  start = vi.fn(() => {
    this.state = 'recording';
  });
  stop = vi.fn();
  constructor() {
    recorders.push(this);
  }
}

let stream: FakeStream;
let getDisplayMedia: ReturnType<typeof vi.fn>;
let original: { md: unknown; mr: unknown };

beforeEach(() => {
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
});

afterEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: original.md });
  (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = original.mr;
});

function renderAddQuestion() {
  return render(
    <MemoryRouter>
      <QuestionEditor
        autoFocusQuestion
        submitLabel="Add question"
        allowImage
        onSave={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
      />
    </MemoryRouter>,
  );
}

/** Opens the recorder from the Visual (optional) row, exactly as a coach does. */
async function openRecorder() {
  fireEvent.click(screen.getByRole('button', { name: /or record a clip/i }));
  await act(async () => {});
}

async function chooseSource() {
  fireEvent.click(screen.getByRole('button', { name: /choose what to record/i }));
  // getDisplayMedia resolves on a microtask the click does not await, and the
  // post-grant applyConstraints adds another.
  await act(async () => {});
  await act(async () => {});
}

describe('Add Question -> Record Clip reaches READY', () => {
  it('shows the READY state after the coach chooses a source', async () => {
    renderAddQuestion();
    await openRecorder();
    await chooseSource();

    // THE REGRESSION. All three of these were missing in production.
    expect(screen.getByRole('button', { name: /^start recording$/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/nothing is being recorded yet/i);
    expect(document.querySelector('video')).toBeInTheDocument();
  });

  it('does not start recording merely because a source was chosen', async () => {
    renderAddQuestion();
    await openRecorder();
    await chooseSource();

    expect(recorders).toHaveLength(0);
    expect(screen.queryByText(/recording ·/i)).toBeNull();
  });

  it('asks for NO size constraint that could refuse the capture', async () => {
    // The root cause. A maximum the display surface cannot satisfy rejects the
    // whole call, and the coach never reaches READY.
    renderAddQuestion();
    await openRecorder();
    await chooseSource();

    const constraints = getDisplayMedia.mock.calls[0][0];
    expect(constraints.audio).toBe(false);
    expect(constraints.video.frameRate).toBe(30);
    expect(constraints.video.width).toBeUndefined();
    expect(constraints.video.height).toBeUndefined();
  });

  it('applies the 1080p cap to the track once the share is granted', async () => {
    // The quality intent survives; only the failure mode changed.
    renderAddQuestion();
    await openRecorder();
    await chooseSource();

    expect(stream.track.applyConstraints).toHaveBeenCalledWith({
      width: { max: 1920 },
      height: { max: 1080 },
    });
  });

  it('still reaches READY when the cap is refused', async () => {
    // A clip at the source's own resolution is what shipped before the cap
    // existed. Losing the take over a quality preference is not acceptable.
    stream.track.applyConstraints = vi.fn(() => Promise.reject(new Error('nope')));
    renderAddQuestion();
    await openRecorder();
    await chooseSource();

    expect(screen.getByRole('button', { name: /^start recording$/i })).toBeInTheDocument();
  });

  it('starts on the ALREADY GRANTED stream, without a second picker', async () => {
    renderAddQuestion();
    await openRecorder();
    await chooseSource();

    fireEvent.click(screen.getByRole('button', { name: /^start recording$/i }));

    expect(recorders).toHaveLength(1);
    expect(recorders[0].start).toHaveBeenCalled();
    // The coach already chose. Asking again would be a second picker.
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/recording · 00 \/ 20 sec/i)).toBeInTheDocument();
  });
});

describe('a share that does not happen is never silent', () => {
  it('says something when the browser refuses', async () => {
    // A refusal and a cancellation both arrive as NotAllowedError, so the
    // coach gets a line either way rather than an unchanged screen.
    const denied = Object.assign(new Error('Permission denied'), {
      name: 'NotAllowedError',
    });
    getDisplayMedia.mockRejectedValue(denied);

    renderAddQuestion();
    await openRecorder();
    await chooseSource();

    expect(screen.getByRole('status')).toHaveTextContent(/nothing was shared/i);
    // And it stays usable: the coach can try again immediately.
    expect(
      screen.getByRole('button', { name: /choose what to record/i }),
    ).toBeInTheDocument();
  });

  it('quietly, without an alarm, for an ordinary cancellation', async () => {
    const cancelled = Object.assign(new Error('Permission denied by user'), {
      name: 'NotAllowedError',
    });
    getDisplayMedia.mockRejectedValue(cancelled);

    renderAddQuestion();
    await openRecorder();
    await chooseSource();

    // A status line, not an alert - cancelling is ordinary and nothing is wrong.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('names an unexpected reason so the next report carries it', async () => {
    const odd = Object.assign(new Error('boom'), { name: 'NotFoundError' });
    getDisplayMedia.mockRejectedValue(odd);

    renderAddQuestion();
    await openRecorder();
    await chooseSource();

    expect(screen.getByRole('status')).toHaveTextContent(/NotFoundError/);
  });

  it('never leaves the recorder stuck with no way forward', async () => {
    getDisplayMedia.mockRejectedValue(
      Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }),
    );
    renderAddQuestion();
    await openRecorder();
    await chooseSource();

    // Retry works, and the second attempt can succeed.
    getDisplayMedia.mockResolvedValue(stream);
    await chooseSource();
    expect(screen.getByRole('button', { name: /^start recording$/i })).toBeInTheDocument();
  });
});
