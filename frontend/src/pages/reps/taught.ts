import type { RepTaught } from '../../api/reps';

/** "Taught Oct 16 by coach1." - when, and who, so a second coach knows it happened. */
export function taughtLine(taught: RepTaught): string {
  const when = new Date(taught.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `Taught ${when}${taught.by ? ` by ${taught.by}` : ''}.`;
}
