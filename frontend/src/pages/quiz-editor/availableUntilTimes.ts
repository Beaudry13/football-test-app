/**
 * When a Peira stops being available - the moments, not the control.
 *
 * KEPT SEPARATE FROM THE COMPONENT for the same reason `playUrl.ts` is: what
 * needs guarding is the VALUE. A preset that lands on the wrong hour, or a
 * summary that reads back a different time from the one chosen, is the bug
 * that matters - and these are pure functions a test can assert exactly,
 * including across a DST boundary.
 *
 * THE BROWSER OWNS THE TIMEZONE. Every moment here is resolved through the
 * platform Date, which carries a real IANA database, so "tomorrow at 9" means
 * 9am where the coach is even across a clock change. The value handed to the
 * server is an absolute instant; Peira stores no coach timezone, and this is
 * the reason it does not need one yet.
 */

export interface Preset {
  label: string;
  at: () => Date;
}

function atHour(daysAhead: number, hour: number): Date {
  const when = new Date();
  when.setDate(when.getDate() + daysAhead);
  when.setHours(hour, 0, 0, 0);
  return when;
}

/** Resolved against the coach's own clock at click time, so "tonight" means
 *  tonight where they are - including across a DST change, which the browser's
 *  own database handles. */
export const PRESETS: Preset[] = [
  { label: 'Tonight', at: () => atHour(0, 23) },
  { label: 'Tomorrow morning', at: () => atHour(1, 9) },
  { label: 'In 24 hours', at: () => new Date(Date.now() + 24 * 60 * 60 * 1000) },
  { label: 'In 3 days', at: () => atHour(3, 9) },
];

/** The historical fixed window, still the default so activation asks nothing
 *  extra of a coach who does not care. Changing this changes what every
 *  activation does by default, so it is named rather than buried. */
export const DEFAULT_PRESET = PRESETS[2];

/** The zone the browser actually resolved this in - "EDT", "GMT+1".
 *
 * SHOWN SO A TRAVELLING COACH IS NOT SETTING AN INSTANT THEY DID NOT MEAN.
 * Peira stores no organization timezone, so "9:00 AM" means 9:00 AM on the
 * machine in front of them - which is right at home and surprising in a
 * different one. Naming it costs three characters and removes the surprise.
 *
 * Falls back to an empty string rather than throwing: a runtime without
 * timeZoneName support should cost the label, never the summary.
 */
export function zoneLabel(when: Date): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZoneName: 'short',
    }).formatToParts(when);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/** "Saturday, Aug 22 at 9:00 AM EDT" - the sentence the coach should be able
 *  to check at a glance, including WHICH clock it is on. Rendered in their own
 *  locale and timezone, which is the one the value was resolved in. */
export function describe(when: Date): string {
  const today = new Date();
  const isToday = when.toDateString() === today.toDateString();
  const isTomorrow =
    when.toDateString() === new Date(today.getTime() + 86400000).toDateString();
  const day = isToday
    ? 'today'
    : isTomorrow
      ? 'tomorrow'
      : when.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const zone = zoneLabel(when);
  return `${day} at ${time}${zone ? ` ${zone}` : ''}`;
}

export function toLocalInputValue(when: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
}
