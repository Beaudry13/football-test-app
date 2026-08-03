import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTypingTarget, useAnnotationKeyboard, type AnnotationKeyboardHandlers } from './useAnnotationKeyboard';

function createHandlers(handled = true): AnnotationKeyboardHandlers {
  return {
    onUndo: vi.fn(() => handled),
    onRedo: vi.fn(() => handled),
    onCopy: vi.fn(() => handled),
    onPaste: vi.fn(() => handled),
    onDelete: vi.fn(() => handled),
    onEscape: vi.fn(() => handled),
  };
}

/** Dispatches on `target` (default: document.body, i.e. not a text field). */
function press(key: string, options: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

describe('isTypingTarget', () => {
  it.each(['input', 'textarea', 'select'])('treats a <%s> as a typing target', (tag) => {
    expect(isTypingTarget(document.createElement(tag))).toBe(true);
  });

  it('treats a contenteditable element as a typing target', () => {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isTypingTarget(div)).toBe(true);
  });

  it('does not treat an ordinary element or a null target as a typing target', () => {
    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('useAnnotationKeyboard', () => {
  let handlers: AnnotationKeyboardHandlers;

  beforeEach(() => {
    handlers = createHandlers();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('routes each shortcut to its handler and suppresses the browser default', () => {
    renderHook(() => useAnnotationKeyboard(handlers, true));

    expect(press('z', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(handlers.onUndo).toHaveBeenCalled();

    expect(press('z', { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(handlers.onRedo).toHaveBeenCalledTimes(1);

    press('y', { ctrlKey: true });
    expect(handlers.onRedo).toHaveBeenCalledTimes(2);

    press('c', { ctrlKey: true });
    expect(handlers.onCopy).toHaveBeenCalled();

    press('v', { ctrlKey: true });
    expect(handlers.onPaste).toHaveBeenCalled();

    press('Delete');
    press('Backspace');
    expect(handlers.onDelete).toHaveBeenCalledTimes(2);

    press('Escape');
    expect(handlers.onEscape).toHaveBeenCalled();
  });

  it('accepts Cmd as well as Ctrl, for macOS', () => {
    renderHook(() => useAnnotationKeyboard(handlers, true));

    press('z', { metaKey: true });
    press('c', { metaKey: true });

    expect(handlers.onUndo).toHaveBeenCalled();
    expect(handlers.onCopy).toHaveBeenCalled();
  });

  it('leaves Ctrl+C/V/Z alone while the coach is typing in a text field', () => {
    renderHook(() => useAnnotationKeyboard(handlers, true));
    const input = document.createElement('input');
    document.body.appendChild(input);

    expect(press('c', { ctrlKey: true }, input).defaultPrevented).toBe(false);
    expect(press('v', { ctrlKey: true }, input).defaultPrevented).toBe(false);
    expect(press('z', { ctrlKey: true }, input).defaultPrevented).toBe(false);
    expect(press('Backspace', {}, input).defaultPrevented).toBe(false);

    expect(handlers.onCopy).not.toHaveBeenCalled();
    expect(handlers.onPaste).not.toHaveBeenCalled();
    expect(handlers.onUndo).not.toHaveBeenCalled();
    expect(handlers.onDelete).not.toHaveBeenCalled();
  });

  it('leaves the keystroke to the browser when the editor declines to handle it', () => {
    renderHook(() => useAnnotationKeyboard(createHandlers(false), true));

    expect(press('c', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press('Delete').defaultPrevented).toBe(false);
  });

  it('never claims Ctrl+P, so printing still works', () => {
    renderHook(() => useAnnotationKeyboard(handlers, true));
    expect(press('p', { ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it('does nothing while disabled, and stops listening once unmounted', () => {
    const { unmount } = renderHook(() => useAnnotationKeyboard(handlers, false));
    press('z', { ctrlKey: true });
    expect(handlers.onUndo).not.toHaveBeenCalled();
    unmount();

    const enabled = renderHook(() => useAnnotationKeyboard(handlers, true));
    enabled.unmount();
    press('z', { ctrlKey: true });
    expect(handlers.onUndo).not.toHaveBeenCalled();
  });
});
