import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDocumentTitle } from './useDocumentTitle';

describe('useDocumentTitle', () => {
  const originalTitle = document.title;

  beforeEach(() => {
    document.title = 'Peira';
  });

  afterEach(() => {
    document.title = originalTitle;
  });

  it('sets document.title while mounted', () => {
    renderHook(() => useDocumentTitle('Week 1 Prep | Peira'));
    expect(document.title).toBe('Week 1 Prep | Peira');
  });

  it('restores the prior title on unmount', () => {
    const { unmount } = renderHook(() => useDocumentTitle('Week 1 Prep | Peira'));
    unmount();
    expect(document.title).toBe('Peira');
  });

  it('does not touch document.title for a falsy value', () => {
    renderHook(() => useDocumentTitle(undefined));
    expect(document.title).toBe('Peira');
  });

  it('updates the title again when the value changes', () => {
    const { rerender } = renderHook(({ title }) => useDocumentTitle(title), {
      initialProps: { title: 'Week 1 Prep | Peira' },
    });
    expect(document.title).toBe('Week 1 Prep | Peira');

    rerender({ title: 'Week 2 Prep | Peira' });
    expect(document.title).toBe('Week 2 Prep | Peira');
  });
});
