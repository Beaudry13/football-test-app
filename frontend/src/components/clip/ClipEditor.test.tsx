import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipEditor } from './ClipEditor';

/** The editor's behaviour, as opposed to its arithmetic (clipEditing.test.ts).
 *
 * THE ASSERTION THAT MATTERS MOST is that an untouched clip is handed back as
 * the SAME Blob object - not an equal one, the same one. That is what proves
 * no second encode happened: a coach who never touches a handle pays nothing,
 * waits for nothing, and loses no quality. Anything that makes `encodeCropTrim`
 * run on the default path is a regression for every coach, including the ones
 * who never wanted this feature.
 *
 * The encoder itself is mocked here. It needs a real MediaRecorder, a real
 * canvas and roughly real time - none of which jsdom has - and it was proven
 * against real bytes in the Phase 0 spike instead.
 */

const encodeSpy = vi.hoisted(() => vi.fn());
vi.mock('./clipEditing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./clipEditing')>();
  return { ...actual, encodeCropTrim: encodeSpy };
});

const SOURCE = new Blob(['original-recording-bytes'], { type: 'video/mp4' });
const EDITED = new Blob(['edited-bytes'], { type: 'video/mp4' });

function renderEditor(overrides: Partial<Parameters<typeof ClipEditor>[0]> = {}) {
  const onDone = vi.fn();
  const onCancel = vi.fn();
  render(
    <ClipEditor
      blob={SOURCE}
      previewUrl="blob:preview"
      sourceWidth={1920}
      sourceHeight={1080}
      durationMs={20_000}
      mimeType='video/mp4;codecs="avc1.42E01E"'
      onDone={onDone}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onDone, onCancel };
}

const useClip = () => fireEvent.click(screen.getByRole('button', { name: /use clip/i }));
const setTrim = (label: RegExp, ms: number) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value: String(ms) } });

beforeEach(() => {
  encodeSpy.mockReset();
  encodeSpy.mockResolvedValue({
    blob: EDITED,
    width: 1344,
    height: 810,
    durationMs: 12_000,
    framesPainted: 352,
  });
});

describe('doing nothing costs nothing', () => {
  it('hands back the ORIGINAL blob and never encodes', async () => {
    const { onDone } = renderEditor();
    useClip();

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const result = onDone.mock.calls[0][0];
    // The same object, not merely an equal one.
    expect(result.blob).toBe(SOURCE);
    expect(result.wasEdited).toBe(false);
    expect(encodeSpy).not.toHaveBeenCalled();
  });

  it('says so, so the coach knows nothing will be reprocessed', () => {
    renderEditor();
    expect(screen.getByText(/saved exactly as recorded/i)).toBeInTheDocument();
  });

  it('starts at full duration', () => {
    renderEditor();
    expect(screen.getByLabelText(/trim start/i)).toHaveValue('0');
    expect(screen.getByLabelText(/trim end/i)).toHaveValue('20000');
  });
});

describe('an actual edit encodes exactly once', () => {
  it('a trim triggers one encode with the retained range', async () => {
    const { onDone } = renderEditor();
    setTrim(/trim start/i, 3000);
    setTrim(/trim end/i, 15_000);
    useClip();

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(encodeSpy).toHaveBeenCalledTimes(1);
    const call = encodeSpy.mock.calls[0][0];
    expect(call.range).toEqual({ startMs: 3000, endMs: 15_000 });
    // Crop untouched: one pass carries both, and the crop half is a no-op.
    expect(call.crop).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(onDone.mock.calls[0][0].blob).toBe(EDITED);
    expect(onDone.mock.calls[0][0].wasEdited).toBe(true);
  });

  it('passes the SAME mime type and one encode for crop AND trim together', async () => {
    const { onDone } = renderEditor();
    setTrim(/trim start/i, 2000);
    useClip();

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(encodeSpy).toHaveBeenCalledTimes(1);
    expect(encodeSpy.mock.calls[0][0].mimeType).toBe('video/mp4;codecs="avc1.42E01E"');
  });

  it('reports the edited dimensions and duration, not the source ones', async () => {
    const { onDone } = renderEditor();
    setTrim(/trim start/i, 3000);
    useClip();

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const result = onDone.mock.calls[0][0];
    expect(result.width).toBe(1344);
    expect(result.height).toBe(810);
    expect(result.durationMs).toBe(12_000);
  });
});

describe('Reset', () => {
  it('puts every control back to leave-it-alone', async () => {
    const { onDone } = renderEditor();
    setTrim(/trim start/i, 5000);
    fireEvent.click(screen.getByRole('button', { name: /reset/i }));

    expect(screen.getByLabelText(/trim start/i)).toHaveValue('0');
    useClip();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    // Reset restores the passthrough, so nothing is encoded.
    expect(encodeSpy).not.toHaveBeenCalled();
  });
});

describe('a failed edit never costs the recording', () => {
  beforeEach(() => {
    encodeSpy.mockRejectedValue(new Error('Encoding stopped unexpectedly.'));
  });

  it('shows the failure and says the recording is safe', async () => {
    renderEditor();
    setTrim(/trim start/i, 3000);
    useClip();

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent(/recording is safe/i);
  });

  it('offers Try again', async () => {
    renderEditor();
    setTrim(/trim start/i, 3000);
    useClip();

    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('offers Use original, which returns the untouched recording', async () => {
    const { onDone } = renderEditor();
    setTrim(/trim start/i, 3000);
    useClip();

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /use original/i }));

    const result = onDone.mock.calls[0][0];
    expect(result.blob).toBe(SOURCE);
    expect(result.wasEdited).toBe(false);
  });

  it('never hands a partial result to the caller', async () => {
    const { onDone } = renderEditor();
    setTrim(/trim start/i, 3000);
    useClip();

    await screen.findByRole('alert');
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('progress', () => {
  it('counts media seconds rather than spinning', async () => {
    let report: ((f: number) => void) | undefined;
    encodeSpy.mockImplementation((input: { onProgress?: (f: number) => void }) => {
      report = input.onProgress;
      return new Promise(() => {}); // never resolves: hold the processing state
    });

    renderEditor();
    setTrim(/trim start/i, 3000);
    setTrim(/trim end/i, 15_000);
    useClip();

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/applying edits/i);
    expect(status).toHaveTextContent(/0 of 12 seconds/i);

    // The editor is in its processing state now, so the trim controls are
    // gone - progress is driven only by what the encoder reports back.
    report?.(0.5);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/6 of 12 seconds/i));
  });
});

describe('decision point', () => {
  it('blocks a trim that removes it, and explains why', () => {
    renderEditor({ decisionPointMs: 18_000 });
    setTrim(/trim end/i, 15_000);

    expect(screen.getByRole('alert')).toHaveTextContent(/removes the decision point/i);
    expect(screen.getByRole('button', { name: /use clip/i })).toBeDisabled();
  });

  it('clearing it explicitly unblocks the same trim', async () => {
    const { onDone } = renderEditor({ decisionPointMs: 18_000 });
    setTrim(/trim end/i, 15_000);

    fireEvent.click(screen.getByRole('button', { name: /clear decision point/i }));

    expect(screen.getByRole('button', { name: /use clip/i })).toBeEnabled();
    useClip();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0].decisionPointMs).toBeNull();
  });

  it('a point still inside the range is carried through, shifted', async () => {
    const { onDone } = renderEditor({ decisionPointMs: 12_000 });
    setTrim(/trim start/i, 3000);
    useClip();

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onDone.mock.calls[0][0].decisionPointMs).toBe(9000);
  });

  it('nothing is blocked when there is no decision point', () => {
    renderEditor();
    setTrim(/trim end/i, 5000);
    expect(screen.getByRole('button', { name: /use clip/i })).toBeEnabled();
  });
});
