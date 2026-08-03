import { DEFAULT_STYLE, type AnnotationStyle } from './types';

/**
 * The toolbar settings a coach last drew with - colour, thickness, dotted,
 * fill opacity, bold, and both end caps.
 *
 * Module-scoped rather than component state because AnnotationCanvas is
 * remounted per image (see AnnotationPage's `key`), which would otherwise
 * reset the toolbar to red 3px on every question. Deliberately not persisted:
 * this is session memory, not an account setting.
 */
let lastUsedStyle: AnnotationStyle = DEFAULT_STYLE;

export function getRememberedStyle(): AnnotationStyle {
  return lastUsedStyle;
}

export function rememberStyle(style: AnnotationStyle): void {
  lastUsedStyle = style;
}

/** Test seam - restores the shipped defaults between cases. */
export function resetRememberedStyle(): void {
  lastUsedStyle = DEFAULT_STYLE;
}
