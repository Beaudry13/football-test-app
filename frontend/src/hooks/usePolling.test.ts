import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePolling } from './usePolling';

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls fn on each interval tick', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    renderHook(() => usePolling(fn, 1000));

    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not tick when disabled', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    renderHook(() => usePolling(fn, 1000, false));

    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('skips a tick while the previous call is still in flight', async () => {
    let resolveFirst: () => void = () => {};
    const fn = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(undefined);
    renderHook(() => usePolling(fn, 1000));

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    // Next tick fires while the first call's promise is still pending - should be skipped.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('skips a tick while the document is hidden', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    renderHook(() => usePolling(fn, 1000));

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('fires immediately on visibilitychange when the tab becomes visible again', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    renderHook(() => usePolling(fn, 5000));

    hiddenSpy.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('clears the interval and listener on unmount', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => usePolling(fn, 1000));

    unmount();
    await vi.advanceTimersByTimeAsync(5000);

    expect(fn).not.toHaveBeenCalled();
  });
});
