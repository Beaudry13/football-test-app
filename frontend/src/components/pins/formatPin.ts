/** A PIN as a coach reads it aloud and a player copies it down: "482 915".
 *
 * Grouping is display only. The stored and submitted PIN is always the bare
 * six digits; anything that is not six digits is shown untouched rather than
 * reshaped into something that looks valid.
 */
export function formatPin(pin: string): string {
  return /^\d{6}$/.test(pin) ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin;
}
