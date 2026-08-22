import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isTypingTarget,
  TOOL_HOTKEYS,
  useAnnotationKeyboard,
  type AnnotationKeyboardHandlers,
} from './useAnnotationKeyboard';

function createHandlers(handled = true): AnnotationKeyboardHandlers {
  return {
    onUndo: vi.fn(() => handled),
    onRedo: vi.fn(() => handled),
    onCopy: vi.fn(() => handled),
    onPaste: vi.fn(() => handled),
    onDelete: vi.fn(() => handled),
    onEscape: vi.fn(() => handled),
    onSelectTool: vi.fn(() => handled),
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

describe('tool hotkeys', () => {
  it('maps every approved letter to its tool', () => {
    // The coach's word on the left, the model's name on the right - Route is
    // a curve, Draw is freehand, Box is a rectangle.
    expect(TOOL_HOTKEYS).toEqual({
      v: 'select',
      l: 'line',
      a: 'arrow',
      r: 'curve',
      d: 'freehand',
      s: 'rectangle',
      o: 'circle',
      t: 'text',
    });
  });

  it.each(Object.entries(TOOL_HOTKEYS))('%s switches to %s', (key, tool) => {
    const handlers = createHandlers();
    renderHook(() => useAnnotationKeyboard(handlers, true));
    press(key);
    expect(handlers.onSelectTool).toHaveBeenCalledWith(tool);
  });

  it('is case-insensitive, so Shift+L is still Line', () => {
    const handlers = createHandlers();
    renderHook(() => useAnnotationKeyboard(handlers, true));
    press('L', { shiftKey: true });
    expect(handlers.onSelectTool).toHaveBeenCalledWith('line');
  });

  it('NEVER fires with a modifier held', () => {
    // The one that matters: Ctrl/Cmd+A is Select All, not Arrow. Cmd+V is
    // Paste, not the pointer. Without the modifier guard both would switch
    // tools out from under the shortcut the coach actually meant.
    const handlers = createHandlers();
    renderHook(() => useAnnotationKeyboard(handlers, true));
    press('a', { ctrlKey: true });
    press('a', { metaKey: true });
    press('v', { ctrlKey: true });
    press('s', { metaKey: true });
    press('t', { altKey: true });
    expect(handlers.onSelectTool).not.toHaveBeenCalled();
  });

  it.each(['INPUT', 'TEXTAREA'])('does nothing while typing in a %s', (tag) => {
    // T must not become the Text tool while a coach types a question, and A
    // must not become Arrow mid-answer.
    const handlers = createHandlers();
    renderHook(() => useAnnotationKeyboard(handlers, true));
    const field = document.createElement(tag);
    document.body.appendChild(field);
    press('t', {}, field);
    press('a', {}, field);
    expect(handlers.onSelectTool).not.toHaveBeenCalled();
    field.remove();
  });

  it('does nothing while editing text on the canvas itself', () => {
    // Fabric mounts a hidden textarea while a text annotation is being
    // edited; isTypingTarget already covers it, and this pins that it does.
    const handlers = createHandlers();
    renderHook(() => useAnnotationKeyboard(handlers, true));
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    document.body.appendChild(editable);
    press('l', {}, editable);
    expect(handlers.onSelectTool).not.toHaveBeenCalled();
    editable.remove();
  });

  it('leaves an unmapped letter to the browser', () => {
    const handlers = createHandlers();
    renderHook(() => useAnnotationKeyboard(handlers, true));
    const event = press('q');
    expect(handlers.onSelectTool).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
