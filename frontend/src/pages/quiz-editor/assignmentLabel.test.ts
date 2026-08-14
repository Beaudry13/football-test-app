import { describe, expect, it } from 'vitest';
import {
  describeAssignment,
  describeAssignmentBrief,
  describeExclusionScope,
} from './assignmentLabel';
import type { QuizAssignment } from '../../api/types';

/** Naming an assignment for a coach.
 *
 * The browser walkthrough found the excluded row saying only "one assignment",
 * which on a quiz-scoped Results page left a coach unable to tell WHICH
 * delivery had stopped counting. These pin the labels that fixed it - and the
 * fallback that keeps the row working when an assignment cannot be resolved.
 */

function assignment(overrides: Partial<QuizAssignment> = {}): QuizAssignment {
  return {
    access_code_id: 24,
    code: 'W8XTNY',
    activated_at: '2026-08-14T15:00:00Z',
    is_active: false,
    is_valid: false,
    mode: 'GRADED',
    groups: [{ id: 1, name: 'Defense' }],
    submitted_count: 2,
    ...overrides,
  };
}

const LOOKUP = new Map<number, QuizAssignment>([
  [24, assignment()],
  [25, assignment({ access_code_id: 25, code: 'ET4R8S', groups: [{ id: 2, name: 'Offense' }] })],
]);

describe('assignment labels', () => {
  it('names an assignment by its group, date and code', () => {
    const label = describeAssignmentBrief(assignment());

    expect(label).toContain('Defense');
    expect(label).toContain('W8XTNY');
    expect(label).toMatch(/Aug 14/);
  });

  it('falls back to the roster when no group is attached', () => {
    expect(describeAssignmentBrief(assignment({ groups: [] }))).toContain('Whole roster');
  });

  it('keeps the fuller picker label separate from the chip label', () => {
    // The picker earns the submitted count - it tells a coach how much their
    // choice will change. The chip has to fit on a table row.
    expect(describeAssignment(assignment())).toContain('2 submitted');
    expect(describeAssignmentBrief(assignment())).not.toContain('submitted');
  });
});

describe('describeExclusionScope', () => {
  it('1. an assignment-scoped exclusion names the actual assignment', () => {
    const label = describeExclusionScope('assignment', 24, LOOKUP);

    expect(label).toContain('Defense');
    expect(label).toContain('W8XTNY');
    expect(label).not.toBe('one assignment');
  });

  it('2. a quiz-wide exclusion still says all assignments', () => {
    expect(describeExclusionScope('quiz', null, LOOKUP)).toBe('all assignments');
  });

  it('3. two different assignments render distinguishable labels', () => {
    const monday = describeExclusionScope('assignment', 24, LOOKUP);
    const tuesday = describeExclusionScope('assignment', 25, LOOKUP);

    expect(monday).not.toEqual(tuesday);
    expect(monday).toContain('Defense');
    expect(tuesday).toContain('Offense');
  });

  it('4. the label depends on SCOPE, not on whether the exclusion is still active', () => {
    // A restored exclusion describes the same historical scope it always did -
    // nothing about the label reads `restored_at`.
    expect(describeExclusionScope('assignment', 24, LOOKUP)).toContain('Defense');
    expect(describeExclusionScope('quiz', null, LOOKUP)).toBe('all assignments');
  });

  it('5. unresolvable assignment metadata falls back instead of breaking', () => {
    // The access code was deleted, or the assignments request failed. The
    // generic wording is exactly what this row said before labels existed, so
    // the fallback is a known-good state rather than a blank or a crash.
    expect(describeExclusionScope('assignment', 999, LOOKUP)).toBe('one assignment');
    expect(describeExclusionScope('assignment', 24, new Map())).toBe('one assignment');
    expect(describeExclusionScope('assignment', null, LOOKUP)).toBe('one assignment');
  });
});
