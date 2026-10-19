import { useId } from 'react'
import type { Concept } from '../../api/concepts'
import { nearDuplicate, resolveConcept, suggestConcepts } from './conceptMatch'

/**
 * A CONCEPT, REUSED. Type, and the concepts the team already has come up as
 * one-tap chips; type one that exists (any case, any punctuation) and it says
 * so; type something close ("Motion Adjust") and it offers the real one first.
 * A genuinely new concept is still one Enter away - this guides, it does not
 * forbid.
 *
 * Unstyled on purpose: it takes the class names of the surface it sits in
 * (Motion Lab's dark panel, the notebook's light one).
 */
export function ConceptPicker({
  label,
  value,
  onChange,
  concepts,
  recent = [],
  placeholder = 'Motion adjustment',
  classes = {},
}: {
  label: string
  value: string
  onChange: (name: string) => void
  concepts: Concept[]
  /** Names to offer first when nothing is typed (what this coach used last). */
  recent?: string[]
  placeholder?: string
  classes?: { field?: string; chips?: string; chip?: string; strong?: string; note?: string }
}) {
  const id = useId()
  const exact = resolveConcept(value, concepts)
  const near = exact ? null : nearDuplicate(value, concepts)
  const ordered = value.trim()
    ? suggestConcepts(value, concepts)
    : [
        ...recent.map((name) => concepts.find((c) => c.name === name)).filter((c): c is Concept => !!c),
        ...concepts.filter((c) => !recent.includes(c.name)),
      ].slice(0, 5)
  const chips = ordered.filter((c) => c.id !== exact?.id && c.id !== near?.id)

  return (
    <div className={classes.field}>
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={80} autoComplete="off" />
      {exact && value.trim() !== exact.name && (
        <span className={classes.note}>
          Using <strong>{exact.name}</strong>
        </span>
      )}
      {near && (
        <span className={classes.note}>
          Did you mean{' '}
          <button type="button" className={classes.strong} onClick={() => onChange(near.name)}>
            {near.name}
          </button>
          ?
        </span>
      )}
      {!exact && !near && value.trim() && chips.length === 0 && <span className={classes.note}>A new concept</span>}
      {chips.length > 0 && (
        <span className={classes.chips} role="group" aria-label="Concepts you already have">
          {chips.map((c) => (
            <button key={c.id} type="button" className={classes.chip} onClick={() => onChange(c.name)}>
              {c.name}
            </button>
          ))}
        </span>
      )}
    </div>
  )
}
