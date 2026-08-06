/** Display-time typography tidying for coach-authored text.
 *
 * Coaches type "->" because that is what a keyboard offers, but they mean an
 * arrow. Rendered literally it is two punctuation marks pretending to be one
 * glyph, and in a display serif like Playfair it reads as a floating dash
 * beside a maths symbol rather than as a direction.
 *
 * DISPLAY ONLY. This never touches what is stored. The coach's question text
 * in the database keeps the exact characters they typed, so nothing is
 * destroyed, editing round-trips unchanged, and removing this function
 * restores the previous appearance everywhere at once.
 */

/** "->", "-->" and "--->" all mean the same thing. Bounded rather than "-+"
 * so a run of dashes used as a rule ("-----") is left alone. */
const ARROW_RIGHT = /-{1,3}>/g;
const ARROW_LEFT = /<-{1,3}/g;

/** Replaces typed arrow sequences with real arrow glyphs.
 *
 * Left-pointing is handled first: in "<->" the right-hand rule would
 * otherwise consume the "->" and strip the left head off a double-headed
 * arrow. */
export function renderArrows(text: string): string {
  return text.replace(ARROW_LEFT, '←').replace(ARROW_RIGHT, '→');
}
