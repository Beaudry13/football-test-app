import { useCallback, useRef, useState } from 'react';
import type { Canvas } from 'fabric';

const MAX_HISTORY = 50;

/**
 * Snapshot-based undo/redo for a Fabric canvas. Simpler and far less error-prone
 * than reconstructing an inverse of every possible canvas mutation (move, resize,
 * style change, freehand stroke, group delete, ...) individually.
 */
export function useAnnotationHistory(canvasRef: React.RefObject<Canvas | null>, onRestored?: () => void) {
  const stack = useRef<string[]>([]);
  const index = useRef(-1);
  const isRestoring = useRef(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const syncFlags = useCallback(() => {
    setCanUndo(index.current > 0);
    setCanRedo(index.current < stack.current.length - 1);
  }, []);

  const pushSnapshot = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || isRestoring.current) return;

    const snapshot = JSON.stringify(canvas.toObject(['id']));
    stack.current = stack.current.slice(0, index.current + 1);
    stack.current.push(snapshot);
    if (stack.current.length > MAX_HISTORY) stack.current.shift();
    index.current = stack.current.length - 1;
    syncFlags();
  }, [canvasRef, syncFlags]);

  const restore = useCallback(
    async (targetIndex: number) => {
      const canvas = canvasRef.current;
      const snapshot = stack.current[targetIndex];
      if (!canvas || !snapshot) return;

      isRestoring.current = true;
      await canvas.loadFromJSON(JSON.parse(snapshot));
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      isRestoring.current = false;
      index.current = targetIndex;
      syncFlags();
      onRestored?.();
    },
    [canvasRef, syncFlags, onRestored],
  );

  const undo = useCallback(() => {
    if (index.current > 0) restore(index.current - 1);
  }, [restore]);

  const redo = useCallback(() => {
    if (index.current < stack.current.length - 1) restore(index.current + 1);
  }, [restore]);

  const reset = useCallback(() => {
    stack.current = [];
    index.current = -1;
    pushSnapshot();
  }, [pushSnapshot]);

  return { pushSnapshot, undo, redo, canUndo, canRedo, reset, isRestoring };
}
