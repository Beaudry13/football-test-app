import { useEffect, useRef } from 'react';
import type { AnnotationTool } from './types';

/**
 * True when the keystroke belongs to whatever the coach is typing in, rather
 * than to the annotation editor: any quiz field, folder name, or the hidden
 * textarea Fabric mounts while a text annotation is being edited. Ctrl+C /
 * Ctrl+V / Ctrl+Z have to keep their normal meaning there.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable === true;
}

/** One letter per tool, the way a drawing program has always done it.
 *
 * Chosen to be typeable without looking: the initial where it is free (Line,
 * Arrow, Route, Draw, Text), and the nearest unclaimed letter where it is not
 * - S for a boX because B is nothing, O for a circle because C is Copy in
 * every editor on earth. V for Select is the pointer key every design tool
 * already trained coaches on.
 *
 * The model's names differ from the coach's words, and this map is the one
 * place the two meet: Route is a `curve`, Draw is `freehand`, Box is a
 * `rectangle`.
 */
export const TOOL_HOTKEYS: Readonly<Record<string, AnnotationTool>> = {
  v: 'select',
  l: 'line',
  a: 'arrow',
  r: 'curve',
  d: 'freehand',
  s: 'rectangle',
  o: 'circle',
  t: 'text',
};

/** Each handler returns whether it acted, so the browser default is only
 * suppressed when the editor genuinely took the keystroke. */
export interface AnnotationKeyboardHandlers {
  onUndo: () => boolean;
  onRedo: () => boolean;
  onCopy: () => boolean;
  onPaste: () => boolean;
  onDelete: () => boolean;
  onEscape: () => boolean;
  onSelectTool: (tool: AnnotationTool) => boolean;
}

export function useAnnotationKeyboard(handlers: AnnotationKeyboardHandlers, enabled: boolean): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return;

      // metaKey is Cmd on macOS, ctrlKey is Ctrl on Windows/Linux.
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const h = handlersRef.current;
      let handled = false;

      if (key === 'escape') {
        handled = h.onEscape();
      } else if (key === 'delete' || key === 'backspace') {
        handled = h.onDelete();
      } else if (mod && key === 'z') {
        handled = event.shiftKey ? h.onRedo() : h.onUndo();
      } else if (mod && key === 'y') {
        // Windows' other conventional redo. Deliberately no Ctrl+P binding -
        // that stays with the browser's print dialog.
        handled = h.onRedo();
      } else if (mod && key === 'c') {
        handled = h.onCopy();
      } else if (mod && key === 'v') {
        handled = h.onPaste();
      } else if (!mod && !event.altKey && TOOL_HOTKEYS[key]) {
        // BARE LETTERS ONLY. The modifier check is not decoration: A is Arrow
        // and Ctrl/Cmd+A is Select All, V is the pointer and Cmd+V is Paste
        // (handled above). Without this guard every one of those would switch
        // tools out from under a coach reaching for the shortcut they meant.
        handled = h.onSelectTool(TOOL_HOTKEYS[key]);
      }

      if (handled) event.preventDefault();
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
