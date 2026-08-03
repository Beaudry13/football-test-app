import { useEffect, useRef } from 'react';

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

/** Each handler returns whether it acted, so the browser default is only
 * suppressed when the editor genuinely took the keystroke. */
export interface AnnotationKeyboardHandlers {
  onUndo: () => boolean;
  onRedo: () => boolean;
  onCopy: () => boolean;
  onPaste: () => boolean;
  onDelete: () => boolean;
  onEscape: () => boolean;
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
      }

      if (handled) event.preventDefault();
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
