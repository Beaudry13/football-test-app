/** TELLING TWO SAME-NAMED PLAYERS APART, AND NOTHING MORE.
 *
 * PURELY PRESENTATIONAL. This decides what a coach or player READS next to a
 * name. It must never decide who a player IS: identity, eligibility,
 * assignment, resume, grading, Competition seats and attempt ownership are all
 * `player_id`, and every caller keeps sending that id however the row is
 * labelled. A label is the thing a person reads; it is never the thing a
 * request carries.
 *
 * ONLY WHEN NECESSARY. A name that is unique in the list it is shown in is
 * returned exactly as it came. Jersey and position appear only beside names
 * that collide, so a roster of forty is not forty names wearing metadata to
 * solve a problem two of them have.
 *
 * SCOPED TO THE LIST BEING RENDERED. Two John Smiths on different screens are
 * not a collision for a coach looking at one of them.
 *
 * A COLLISION IS BETWEEN PEOPLE, NOT ROWS. One player can legitimately appear
 * twice in a list - two access codes on one quiz, two practice runs - and a
 * player is not ambiguous with themselves. Callers pass `identity` for that;
 * it only ever SUPPRESSES a label, and is never read for anything else.
 *
 * TWO MODES, BECAUSE THE SOURCES DIFFER:
 *   - 'attempt': Results, grading, Teach Next. Jersey only. The live roster
 *     position must not be stapled onto a record of an attempt - that attempt
 *     has its own `position_at_attempt`, and mixing the two would make a label
 *     that is half history and half today.
 *   - 'roster': live pickers and live boards. Jersey and position, both from
 *     the roster as it stands now.
 *
 * When there is nothing to show, the name is shown plainly. No ids, no
 * initials (both Smiths are "JS"), no colours, nothing invented.
 */

export type PlayerLabelMode = 'attempt' | 'roster';

export interface PlayerLabelInput {
  /** The name exactly as it should be displayed. Never rewritten here. */
  name: string;
  jerseyNumber?: string | null;
  position?: string | null;
  /** Rows sharing an identity are one person and do not collide with each
   *  other. Omitted means every row is its own person. */
  identity?: string | number | null;
}

export interface PlayerLabel {
  /** The name, untouched. */
  name: string;
  /** What distinguishes this row - "#12", "#12 QB", "QB" - or null when the
   *  name is unique in its list, or when there is genuinely nothing to show.
   *  Separate from `name` so a surface can put it on its own line. */
  detail: string | null;
  /** `name`, or `name · detail`. */
  text: string;
}

/** The key two names COLLIDE on. Detection only - never a stored or displayed
 *  value. Trimmed, internal whitespace collapsed, case-insensitive, so
 *  "John Smith", "john smith" and "John  Smith" are one collision group. */
export function collisionKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

function present(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The distinguishing text for one player, regardless of collisions. */
export function playerDetail(input: PlayerLabelInput, mode: PlayerLabelMode): string | null {
  const jersey = present(input.jerseyNumber);
  // A coach may have typed "#12" into the jersey field; never render "##12".
  const jerseyText = jersey ? `#${jersey.replace(/^#+/, '')}` : null;
  if (mode === 'attempt') return jerseyText;

  const position = present(input.position);
  if (jerseyText && position) return `${jerseyText} ${position}`;
  return jerseyText ?? position;
}

/** Labels for every item in one rendered list, in the same order. */
export function playerLabels<T>(
  items: readonly T[],
  read: (item: T) => PlayerLabelInput,
  mode: PlayerLabelMode,
): PlayerLabel[] {
  const inputs = items.map(read);
  const people = new Map<string, Set<string>>();
  inputs.forEach((input, index) => {
    const key = collisionKey(input.name);
    const identity =
      input.identity === undefined || input.identity === null ? `row:${index}` : `id:${input.identity}`;
    const seen = people.get(key) ?? new Set<string>();
    seen.add(identity);
    people.set(key, seen);
  });
  return inputs.map((input) => {
    const collides = (people.get(collisionKey(input.name))?.size ?? 0) > 1;
    const detail = collides ? playerDetail(input, mode) : null;
    return { name: input.name, detail, text: detail ? `${input.name} · ${detail}` : input.name };
  });
}
