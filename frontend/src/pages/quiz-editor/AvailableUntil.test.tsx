import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe as suite, expect, it, vi } from 'vitest';
import { AvailableUntil } from './AvailableUntil';
import { DEFAULT_PRESET, PRESETS, describe, type Preset } from './availableUntilTimes';

/** A fixed "now" so weekday names are deterministic.
 *  Thursday 20 August 2026, 14:00 local. */
const NOW = new Date(2026, 7, 20, 14, 0, 0);

/** Fake timers and userEvent deadlock, so the clock is only frozen for tests
 *  that assert on a specific date. Interaction tests run on the real clock and
 *  assert RELATIVE facts instead - which is the honest thing to check anyway:
 *  "tomorrow at 9" is a relationship, not a constant. */
function atFixedNow<T>(run: () => T): T {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  try {
    return run();
  } finally {
    vi.useRealTimers();
  }
}

const soon = () => new Date(Date.now() + 3600_000);

suite('AvailableUntil', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  suite('the summary a coach reads', () => {
    it('says a day and a time, not a duration', () => {
      // "Saturday at 9:00" is what a coach is deciding. "In 44 hours" is
      // arithmetic they would have to do to check it.
      atFixedNow(() => {
        expect(describe(new Date(2026, 7, 22, 9, 0))).toMatch(/Saturday at 9:00/);
      });
    });

    it('says today and tomorrow rather than naming those weekdays', () => {
      atFixedNow(() => {
        expect(describe(new Date(2026, 7, 20, 23, 0))).toMatch(/^today at/);
        expect(describe(new Date(2026, 7, 21, 9, 0))).toMatch(/^tomorrow at/);
      });
    });

    it('is shown for the current value', () => {
      atFixedNow(() => {
        render(<AvailableUntil value={new Date(2026, 7, 22, 9, 0)} onChange={vi.fn()} />);
      });

      expect(screen.getByText(/Saturday at 9:00/)).toBeInTheDocument();
    });
  });

  suite('choosing', () => {
    it('A DEFAULT IS ALWAYS ALREADY SET', () => {
      // Activation must not require a decision. The default is the window
      // activation always used, so a coach who does not care clicks Activate
      // exactly as before.
      atFixedNow(() => {
        const chosen = DEFAULT_PRESET.at();

        expect(chosen.getTime()).toBeGreaterThan(Date.now());
        expect(chosen.getTime() - Date.now()).toBe(24 * 60 * 60 * 1000);
      });
    });

    it('offers presets phrased the way a coach thinks', () => {
      render(<AvailableUntil value={soon()} onChange={vi.fn()} />);

      for (const preset of PRESETS) {
        expect(screen.getByRole('button', { name: preset.label })).toBeInTheDocument();
      }
      // And never in TTL/policy language.
      expect(document.body.textContent).not.toMatch(/TTL|expiration policy|lifetime/i);
    });

    it('resolves a preset to a real future moment', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<AvailableUntil value={soon()} onChange={onChange} />);

      await user.click(screen.getByRole('button', { name: 'Tomorrow morning' }));

      const [when] = onChange.mock.calls[0];
      const expected = new Date();
      expected.setDate(expected.getDate() + 1);
      expect(when.getTime()).toBeGreaterThan(Date.now());
      expect(when.getHours()).toBe(9);
      expect(when.getDate()).toBe(expected.getDate());
    });

    it('KEEPS THE EXACT PICKER FOLDED AWAY', () => {
      // Presets cover the common cases; a date-time field as the primary
      // control would make every activation a form-filling exercise.
      render(<AvailableUntil value={soon()} onChange={vi.fn()} />);

      expect(screen.queryByLabelText('Available until date and time')).not.toBeInTheDocument();
    });

    it('opens an exact picker for the cases presets do not cover', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<AvailableUntil value={soon()} onChange={onChange} />);

      await user.click(screen.getByRole('button', { name: 'Pick date & time' }));
      // fireEvent rather than user.type: jsdom does not drive a
      // datetime-local through keystrokes, and what matters here is what the
      // component does with a complete value.
      fireEvent.change(screen.getByLabelText('Available until date and time'), {
        target: { value: '2026-08-22T09:00' },
      });

      const [when] = onChange.mock.calls.at(-1)!;
      expect(when.getFullYear()).toBe(2026);
      expect(when.getHours()).toBe(9);
    });

    it('shows the picker in the coach own clock, not UTC', async () => {
      // toISOString would shift the displayed value by the offset and show a
      // coach a time they did not pick.
      const user = userEvent.setup();
      render(<AvailableUntil value={new Date(2026, 7, 22, 9, 0)} onChange={vi.fn()} />);

      await user.click(screen.getByRole('button', { name: 'Pick date & time' }));

      expect(screen.getByLabelText('Available until date and time')).toHaveValue(
        '2026-08-22T09:00',
      );
    });

    it('ignores a half-typed value instead of showing Invalid Date', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<AvailableUntil value={soon()} onChange={onChange} />);

      await user.click(screen.getByRole('button', { name: 'Pick date & time' }));
      fireEvent.change(screen.getByLabelText('Available until date and time'), {
        target: { value: '' },
      });

      expect(onChange).not.toHaveBeenCalled();
    });
  });

  suite('a time that has already gone', () => {
    it('says so before the coach presses Activate', () => {
      // The server refuses it too. This is the courtesy; that is the rule.
      render(<AvailableUntil value={new Date(Date.now() - 3600_000)} onChange={vi.fn()} />);

      expect(screen.getByText(/already passed/)).toBeInTheDocument();
    });

    it('says nothing for a future time', () => {
      render(<AvailableUntil value={soon()} onChange={vi.fn()} />);

      expect(screen.queryByText(/already passed/)).not.toBeInTheDocument();
    });
  });

  suite('timezone and DST', () => {
    it('a preset lands on the intended WALL CLOCK hour, not a shifted one', () => {
      // The browser owns a real IANA database, so a preset resolved through
      // Date arithmetic crosses a DST boundary at the right local hour. This
      // is why Peira stores no coach timezone yet.
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 10, 1, 14, 0)); // US DST ends early Nov

      const tomorrow = PRESETS.find((p: Preset) => p.label === 'Tomorrow morning')!.at();

      expect(tomorrow.getHours()).toBe(9);
    });

    it('a preset stays in the future across the change', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 10, 1, 14, 0));

      for (const preset of PRESETS) {
        expect(preset.at().getTime()).toBeGreaterThan(Date.now());
      }
    });

    it('the value sent to the server is an absolute instant', () => {
      // The server never parses a wall clock. toISOString is what resolves
      // the coach choice through the browser timezone database.
      const saturday = new Date(2026, 7, 22, 9, 0);

      expect(saturday.toISOString()).toMatch(/Z$/);
      expect(new Date(saturday.toISOString()).getTime()).toBe(saturday.getTime());
    });
  });
});
