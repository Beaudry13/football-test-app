import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useScrollLock } from './useScrollLock';

afterEach(() => {
  document.body.removeAttribute('style');
  document.documentElement.removeAttribute('style');
  window.scrollTo(0, 0);
});

/** jsdom does not implement scrolling, so the offset is stubbed the way the
 * browser would report it after the player scrolled down the page. */
function scrolledTo(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true });
}

describe('useScrollLock', () => {
  it('does nothing while inactive', () => {
    renderHook(() => useScrollLock(false));
    expect(document.body.style.position).toBe('');
  });

  it('fixes the body and holds the scroll offset as a negative top', () => {
    scrolledTo(640);
    renderHook(() => useScrollLock(true));

    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.top).toBe('-640px');
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.body.style.width).toBe('100%');
  });

  it('disables overscroll on both body and root to stop pull-to-refresh', () => {
    renderHook(() => useScrollLock(true));
    expect(document.body.style.overscrollBehavior).toBe('none');
    expect(document.documentElement.style.overscrollBehavior).toBe('none');
  });

  it('restores the exact prior scroll position on close', () => {
    scrolledTo(1234);
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const { unmount } = renderHook(() => useScrollLock(true));

    unmount();

    expect(scrollTo).toHaveBeenCalledWith(0, 1234);
    scrollTo.mockRestore();
  });

  it('restores every style it touched, including ones that were never set', () => {
    scrolledTo(200);
    const { unmount } = renderHook(() => useScrollLock(true));
    unmount();

    // An unexpected unmount must not leave the app unable to scroll.
    expect(document.body.style.position).toBe('');
    expect(document.body.style.top).toBe('');
    expect(document.body.style.overflow).toBe('');
    expect(document.body.style.width).toBe('');
    expect(document.body.style.overscrollBehavior).toBe('');
    expect(document.documentElement.style.overscrollBehavior).toBe('');
  });

  it('preserves styles the app had already set on the body', () => {
    document.body.style.overflow = 'auto';
    document.body.style.position = 'relative';
    const { unmount } = renderHook(() => useScrollLock(true));

    expect(document.body.style.position).toBe('fixed');
    unmount();

    expect(document.body.style.overflow).toBe('auto');
    expect(document.body.style.position).toBe('relative');
  });

  it('releases the lock when it toggles off without unmounting', () => {
    scrolledTo(300);
    const { rerender } = renderHook(({ active }) => useScrollLock(active), {
      initialProps: { active: true },
    });
    expect(document.body.style.position).toBe('fixed');

    rerender({ active: false });
    expect(document.body.style.position).toBe('');
  });

  it('survives open/close/open without accumulating stale offsets', () => {
    scrolledTo(500);
    const { rerender } = renderHook(({ active }) => useScrollLock(active), {
      initialProps: { active: true },
    });
    rerender({ active: false });

    scrolledTo(900);
    rerender({ active: true });
    expect(document.body.style.top).toBe('-900px');
  });
});
