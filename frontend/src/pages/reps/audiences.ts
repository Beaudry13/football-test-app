// WHO A REP GOES TO, FROM THE ROSTER PEIRA ALREADY HAS.
//
// The roster carries each player's position as the coach typed it ("S", "FS",
// "CB", "OL"...). A position family groups the abbreviations coaches commonly
// use for one job, so "Safeties" means everyone listed S, FS or SS - and the
// chip always shows exactly which positions and how many players, so nothing
// is hidden behind the name. Positions nobody maps stay their own chip.

import type { Player } from '../../api/types';

export interface Family {
  name: string;
  /** "safeties": how a sentence says them ("4 of 11 safeties missed"). */
  plural: string;
  positions: string[];
  /** Words in a decision's "You're the..." that point at this family. */
  words: string[];
}

export const FAMILIES: Family[] = [
  { name: 'Safeties', plural: 'safeties', positions: ['S', 'FS', 'SS', 'SAF'], words: ['safety', 'safeties'] },
  { name: 'Corners', plural: 'corners', positions: ['CB', 'COR'], words: ['corner'] },
  { name: 'Nickels', plural: 'nickels', positions: ['NB', 'NKL', 'STAR'], words: ['nickel', 'star'] },
  {
    name: 'Linebackers',
    plural: 'linebackers',
    positions: ['LB', 'ILB', 'OLB', 'MLB', 'MIKE', 'WILL', 'SAM'],
    words: ['linebacker', 'backer', 'mike', 'will', 'sam'],
  },
  {
    name: 'Defensive line',
    plural: 'defensive linemen',
    positions: ['DL', 'DE', 'DT', 'NT', 'EDGE'],
    words: ['defensive end', 'defensive tackle', 'nose', 'edge', 'd-line', 'defensive line'],
  },
  {
    name: 'Offensive line',
    plural: 'offensive linemen',
    positions: ['OL', 'LT', 'LG', 'C', 'RG', 'RT', 'OT', 'OG', 'T', 'G'],
    words: ['left tackle', 'right tackle', 'guard', 'center', 'offensive line', 'o-line'],
  },
  { name: 'Quarterbacks', plural: 'quarterbacks', positions: ['QB'], words: ['quarterback'] },
  { name: 'Running backs', plural: 'running backs', positions: ['RB', 'TB', 'HB', 'FB'], words: ['running back', 'tailback', 'fullback'] },
  { name: 'Receivers', plural: 'receivers', positions: ['WR', 'X', 'Z', 'SL', 'SR'], words: ['receiver', 'wideout'] },
  { name: 'Tight ends', plural: 'tight ends', positions: ['TE', 'Y'], words: ['tight end'] },
];

const norm = (position: string) => position.trim().toUpperCase();

export function familyOf(position: string | null | undefined): Family | null {
  if (!position) return null;
  const p = norm(position);
  return FAMILIES.find((f) => f.positions.includes(p)) ?? null;
}

/** One chip: a family (or a lone position), the positions it covers, the players. */
export interface Audience {
  key: string;
  name: string;
  positions: string[];
  playerIds: number[];
  family: Family | null;
}

/** The roster's active players, grouped into the chips a coach picks from - biggest first. */
export function audiencesFrom(players: Player[]): Audience[] {
  const byKey = new Map<string, Audience>();
  for (const p of players) {
    if (!p.is_active || !p.position?.trim()) continue;
    const family = familyOf(p.position);
    const key = family ? `family:${family.name}` : `position:${norm(p.position)}`;
    const entry = byKey.get(key) ?? { key, name: family?.name ?? norm(p.position), positions: [], playerIds: [], family };
    if (!entry.positions.includes(norm(p.position))) entry.positions.push(norm(p.position));
    entry.playerIds.push(p.id);
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .map((a) => ({ ...a, positions: a.positions.sort() }))
    .sort((a, b) => b.playerIds.length - a.playerIds.length || a.name.localeCompare(b.name));
}

/** The family a Rep's "You're the..." roles point at, when they agree on one. */
export function suggestedFamily(roles: (string | null)[]): Family | null {
  const found = new Set<Family>();
  for (const role of roles) {
    if (!role) continue;
    const r = role.toLowerCase();
    const hit = FAMILIES.find((f) => f.words.some((w) => r.includes(w)));
    if (hit) found.add(hit);
  }
  return found.size === 1 ? [...found][0] : null;
}

/** "safeties" when every position a Rep went to is one family; null otherwise. */
export function pluralFor(positions: string[]): string | null {
  if (positions.length === 0) return null;
  const families = new Set(positions.map((p) => familyOf(p)?.name ?? `?${p}`));
  if (families.size !== 1) return null;
  return familyOf(positions[0])?.plural ?? null;
}
