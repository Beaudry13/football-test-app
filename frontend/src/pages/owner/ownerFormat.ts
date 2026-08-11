/** Formatting shared by every Owner Dashboard screen.
 *
 * Small, but deliberately shared: "—" for unknown has to look identical on
 * the overview, the organizations table, the detail page and the coaches
 * table, because the entire honesty argument for these metrics rests on a
 * reader being able to tell "we don't know" apart from "zero". */

/** Thousands separators, tabular-friendly. */
export function count(value: number): string {
  return value.toLocaleString();
}

/** The em dash used everywhere a value is genuinely unknown.
 *
 * NOT a zero and NOT a guessed date. `last_activity` and
 * `last_attributed_activity` are null when nothing in the schema can answer
 * the question, and showing "0" or "Never" there would both assert something
 * the data does not support. */
export const UNKNOWN = '—';

/** A compact, scannable relative age: "Today", "3d ago", "2mo ago".
 *
 * Relative rather than absolute because the operator's question is "has this
 * organization gone quiet", which is about elapsed time, not a calendar date.
 * The exact timestamp stays available as a title attribute at the call site. */
export function relativeDay(iso: string | null): string {
  if (!iso) return UNKNOWN;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return UNKNOWN;

  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Absolute date for columns where "when did this start" is the question -
 *  a signup date is a fact, not an elapsed duration. */
export function shortDate(iso: string | null): string {
  if (!iso) return UNKNOWN;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return UNKNOWN;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Full timestamp for hover, so the compact relative label never costs
 *  precision when precision is what's wanted. */
export function exactTime(iso: string | null): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString();
}
