// INTEGRATION: where Motion Lab's keyboard shortcuts are allowed to act.
//
// The prototype owned the whole page and only skipped INPUT. Inside PEIRA the
// editor shares the document with the rest of the app, so the rule is stated
// once here and tested in keyboardScope.test.tsx.

/**
 * Does this keystroke belong to the Motion Lab field?
 *
 * Not when it is typed into a text control - an input, textarea, select or
 * anything contenteditable - and not when it happens outside the editor. With
 * nothing focused a keystroke targets <body>, and that still counts: it is how
 * a coach who just clicked the field presses D or Space. An event dispatched
 * on the window or document itself is page-level too, as the prototype
 * treated it.
 */
export function isEditorKeystroke(target: EventTarget | null, editor: Element | null): boolean {
  if (!target) return false
  // The window is not a Node (and a wrapped window need not be === `window`).
  if (!(target instanceof Node) || target === document) return true
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return false
  if (target === document.body || target === document.documentElement) return true
  return !!editor && editor.contains(target)
}
