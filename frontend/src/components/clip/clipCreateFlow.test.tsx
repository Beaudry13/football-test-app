import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ClipRecorder } from './ClipRecorder';

/** RECORD WHILE WRITING THE QUESTION, not after saving it.
 *
 * Record Clip shipped reachable only from an existing question's overflow
 * menu, so building a clip question meant: create -> save -> find it again ->
 * open a menu -> record. These cover the capability gate at the point a coach
 * meets it during creation.
 */

function withRecorder(supported: string[], hasDisplayMedia = true) {
  const original = {
    md: (navigator as unknown as { mediaDevices?: unknown }).mediaDevices,
    mr: (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder,
  };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: hasDisplayMedia ? { getDisplayMedia: vi.fn() } : {},
  });
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = {
    isTypeSupported: (m: string) => supported.includes(m),
  };
  return () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: original.md,
    });
    (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder = original.mr;
  };
}

describe('ClipRecorder in the create flow', () => {
  it('offers recording when the browser can produce MP4', () => {
    const restore = withRecorder(['video/mp4;codecs="avc1.42E01E"']);
    try {
      render(<ClipRecorder onUse={vi.fn()} onCancel={vi.fn()} />);
      // The entry point is the PICKER, not the clock - choosing a source and
      // starting the recording are two deliberate presses.
      expect(
        screen.getByRole('button', { name: /choose what to record/i }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^start recording$/i })).toBeNull();
      expect(screen.getByText(/up to 15 seconds, no sound/i)).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('refuses - and never offers to record - when only WebM is available', async () => {
    // The measured default of Chrome and Edge. A coach must be stopped BEFORE
    // recording, not left with a take that cannot be saved.
    const restore = withRecorder(['video/webm;codecs=vp9', 'video/webm']);
    try {
      render(<ClipRecorder onUse={vi.fn()} onCancel={vi.fn()} />);
      expect(screen.queryByRole('button', { name: /choose what to record/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /^start recording$/i })).toBeNull();
      expect(screen.getByText(/needs a browser that can record MP4/i)).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('refuses where screen capture does not exist', async () => {
    // iOS and Android. The rest of question creation must still work, which is
    // why this component refuses rather than the form disabling itself.
    const restore = withRecorder(['video/mp4'], false);
    try {
      const onCancel = vi.fn();
      render(<ClipRecorder onUse={vi.fn()} onCancel={onCancel} />);
      expect(screen.getByText(/needs a browser that can record MP4/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /close/i }));
      expect(onCancel).toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
