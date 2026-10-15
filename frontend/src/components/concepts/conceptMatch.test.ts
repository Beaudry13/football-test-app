import { describe, expect, it } from 'vitest'
import { nearDuplicate, normalizeConcept, resolveConcept, suggestConcepts } from './conceptMatch'

/** ONE "Motion adjustment", not five spellings of it. */

const C = [
  { id: 1, name: 'Motion adjustment', is_archived: false },
  { id: 2, name: 'Leverage', is_archived: false },
  { id: 3, name: 'Coverage ID', is_archived: false },
  { id: 4, name: 'Red zone check', is_archived: false },
]

describe('concept reuse', () => {
  it('the same words are the same concept, whatever the case or punctuation', () => {
    expect(normalizeConcept('  Motion-Adjustment!! ')).toBe('motion adjustment')
    for (const typed of ['motion adjustment', 'MOTION ADJUSTMENT', 'Motion  Adjustment', 'motion-adjustment']) {
      expect(resolveConcept(typed, C)?.id).toBe(1)
    }
    expect(resolveConcept('Motion adjust', C)).toBeNull()
  })

  it('a shortened word or a slip of the finger is offered the real one', () => {
    expect(nearDuplicate('Motion Adjust', C)?.id).toBe(1)
    expect(nearDuplicate('Motion Ajdustment', C)?.id).toBe(1)
    expect(nearDuplicate('Levrage', C)?.id).toBe(2)
    // Exactly one is not a near duplicate, and something new is not either.
    expect(nearDuplicate('motion adjustment', C)).toBeNull()
    expect(nearDuplicate('Blitz pickup', C)).toBeNull()
  })

  it('suggests what the team already has as the coach types, closest first', () => {
    expect(suggestConcepts('mot', C).map((c) => c.id)).toEqual([1])
    expect(suggestConcepts('red z', C).map((c) => c.id)).toEqual([4])
    expect(suggestConcepts('cov', C).map((c) => c.id)).toEqual([3])
    expect(suggestConcepts('', C, 2).map((c) => c.id)).toEqual([1, 2])
  })
})
