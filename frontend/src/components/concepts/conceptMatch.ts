// CONCEPT REUSE: one "Motion adjustment", not five spellings of it.
//
// The server already treats names case-insensitively (concepts are unique
// per organization, ignoring case). This adds the human part a coach types
// past: punctuation and spacing ("Motion-Adjustment"), a shortened word
// ("Motion Adjust"), a slip of the finger ("Motion Ajdustment"). Matching is
// deliberately small - normalise, prefix, one or two typos - not a taxonomy.

import type { Concept } from '../../api/concepts'

/** "  Motion-Adjustment!! " -> "motion adjustment" */
export function normalizeConcept(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** The existing concept this text IS (same words, any case or punctuation), or null. */
export function resolveConcept(text: string, concepts: Concept[]): Concept | null {
  const q = normalizeConcept(text)
  if (!q) return null
  return concepts.find((c) => normalizeConcept(c.name) === q) ?? null
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = keep
    }
  }
  return row[b.length]
}

/** How close `q` (normalised text) is to a concept name: lower is closer, null is unrelated. */
function closeness(q: string, name: string): number | null {
  const n = normalizeConcept(name)
  if (n === q) return 0
  if (q.length >= 3 && (n.startsWith(q) || (q.length >= 4 && q.startsWith(n)))) return 1
  // Every typed word starts a word of the name: "mot adj" -> "motion adjustment".
  const words = n.split(' ')
  if (q.split(' ').every((w) => w.length >= 2 && words.some((x) => x.startsWith(w)))) return 2
  if (q.length >= 4 && n.includes(q)) return 2
  if (q.length >= 5 && distance(q, n) <= 2) return 3
  return null
}

/** Existing concepts worth offering for what has been typed, closest first. Empty text: the given order. */
export function suggestConcepts(text: string, concepts: Concept[], limit = 4): Concept[] {
  const q = normalizeConcept(text)
  if (!q) return concepts.slice(0, limit)
  return concepts
    .map((c) => ({ c, d: closeness(q, c.name) }))
    .filter((x): x is { c: Concept; d: number } => x.d !== null)
    .sort((a, b) => a.d - b.d || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map((x) => x.c)
}

/** A concept the text is probably MEANT to be ("Motion Adjust" -> "Motion adjustment"), when it is not exactly one. */
export function nearDuplicate(text: string, concepts: Concept[]): Concept | null {
  if (resolveConcept(text, concepts)) return null
  const q = normalizeConcept(text)
  if (q.length < 4) return null
  const best = concepts
    .map((c) => ({ c, d: closeness(q, c.name) }))
    .filter((x) => x.d !== null && (x.d === 1 || x.d === 3))
    .sort((a, b) => (a.d as number) - (b.d as number))[0]
  return best ? best.c : null
}
