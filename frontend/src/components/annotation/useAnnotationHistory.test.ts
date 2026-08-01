import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Canvas } from 'fabric';
import { useAnnotationHistory } from './useAnnotationHistory';

/**
 * The hook only ever calls these four Canvas methods, so a lightweight fake
 * is enough to test its undo/redo state machine in isolation - no real
 * Fabric.js canvas (and no native <canvas> rendering) needed.
 */
function createMockCanvas() {
  let objects: string[] = [];
  return {
    setContents: (value: string[]) => {
      objects = value;
    },
    toObject: vi.fn((): unknown => ({ objects: [...objects] })),
    loadFromJSON: vi.fn(async (data: { objects: string[] }) => {
      objects = data.objects;
    }),
    discardActiveObject: vi.fn(),
    requestRenderAll: vi.fn(),
  };
}

describe('useAnnotationHistory', () => {
  let mockCanvas: ReturnType<typeof createMockCanvas>;
  let canvasRef: { current: Canvas | null };

  beforeEach(() => {
    mockCanvas = createMockCanvas();
    canvasRef = { current: mockCanvas as unknown as Canvas };
  });

  it('starts with nothing to undo or redo', () => {
    const { result } = renderHook(() => useAnnotationHistory(canvasRef));

    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('reset() establishes a baseline snapshot that alone cannot be undone', () => {
    const { result } = renderHook(() => useAnnotationHistory(canvasRef));

    act(() => result.current.reset());

    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('pushSnapshot() after reset makes undo available', () => {
    const { result } = renderHook(() => useAnnotationHistory(canvasRef));
    act(() => result.current.reset());

    mockCanvas.setContents(['rectangle-1']);
    act(() => result.current.pushSnapshot());

    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('undo() restores the previous snapshot and enables redo', async () => {
    const onRestored = vi.fn();
    const { result } = renderHook(() => useAnnotationHistory(canvasRef, onRestored));
    act(() => result.current.reset()); // baseline: []
    mockCanvas.setContents(['rectangle-1']);
    act(() => result.current.pushSnapshot());

    act(() => result.current.undo());
    await waitFor(() => expect(result.current.canRedo).toBe(true));

    expect(mockCanvas.loadFromJSON).toHaveBeenLastCalledWith({ objects: [] });
    expect(result.current.canUndo).toBe(false);
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it('redo() re-applies the snapshot that was just undone', async () => {
    const { result } = renderHook(() => useAnnotationHistory(canvasRef));
    act(() => result.current.reset());
    mockCanvas.setContents(['rectangle-1']);
    act(() => result.current.pushSnapshot());
    act(() => result.current.undo());
    await waitFor(() => expect(result.current.canRedo).toBe(true));

    act(() => result.current.redo());
    await waitFor(() => expect(result.current.canUndo).toBe(true));

    expect(mockCanvas.loadFromJSON).toHaveBeenLastCalledWith({ objects: ['rectangle-1'] });
    expect(result.current.canRedo).toBe(false);
  });

  it('drops the redo branch once a new snapshot is pushed after an undo', async () => {
    const { result } = renderHook(() => useAnnotationHistory(canvasRef));
    act(() => result.current.reset());
    mockCanvas.setContents(['rectangle-1']);
    act(() => result.current.pushSnapshot());
    act(() => result.current.undo());
    await waitFor(() => expect(result.current.canRedo).toBe(true));

    mockCanvas.setContents(['circle-1']); // a different action than the undone one
    act(() => result.current.pushSnapshot());

    expect(result.current.canRedo).toBe(false);
  });

  it('pushSnapshot() is a no-op while isRestoring is set', () => {
    const { result } = renderHook(() => useAnnotationHistory(canvasRef));
    act(() => result.current.reset());

    result.current.isRestoring.current = true;
    mockCanvas.setContents(['snuck-in-during-restore']);
    act(() => result.current.pushSnapshot());

    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });
});
