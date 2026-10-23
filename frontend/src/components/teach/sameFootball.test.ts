import { describe, expect, it } from 'vitest';
import type { Question, Quiz } from '../../api/types';
import { distinctFootball } from './sameFootball';

/**
 * THE SAME FOOTBALL, TAUGHT ONCE - by identity, not by wording. A retest copy
 * (copied from the original, however many times) is the original; two
 * different questions that happen to share words are both taught.
 */

const q = (id: number, text: string, copiedFrom: number | null = null) =>
  ({ id, question_text: text, copied_from_question_id: copiedFrom }) as unknown as Question;
const quiz = (id: number, retestOf: number | null = null) =>
  ({ id, ...(retestOf !== null ? { retest_of: { id: retestOf } } : {}) }) as unknown as Pick<Quiz, 'id' | 'retest_of'>;
const ids = (list: Question[]) => list.map((x) => x.id);

describe('distinctFootball', () => {
  it('two different football questions with identical wording both appear', () => {
    const out = distinctFootball([
      { quiz: quiz(1), question: q(10, 'Your check?') },
      { quiz: quiz(1), question: q(11, 'Your check?') },
      { quiz: quiz(2), question: q(20, 'Your check?') },
    ]);
    expect(ids(out)).toEqual([10, 11, 20]);
  });

  it('a retest copy of the same original is taught once - whichever comes first', () => {
    expect(ids(distinctFootball([
      { quiz: quiz(5, 1), question: q(50, 'Rotate or stay?', 10) },
      { quiz: quiz(1), question: q(10, 'Rotate or stay?') },
    ]))).toEqual([50]);
    expect(ids(distinctFootball([
      { quiz: quiz(1), question: q(10, 'Rotate or stay?') },
      { quiz: quiz(5, 1), question: q(50, 'Rotate or stay?', 10) },
    ]))).toEqual([10]);
  });

  it('identity, not words: a copy reworded is still the same football', () => {
    expect(ids(distinctFootball([
      { quiz: quiz(1), question: q(10, 'What is your check?') },
      { quiz: quiz(5, 1), question: q(50, 'Motion across - your check?', 10) },
    ]))).toEqual([10]);
  });

  it('a copy of a copy is the original too', () => {
    expect(ids(distinctFootball([
      { quiz: quiz(6, 5), question: q(60, 'Rotate or stay?', 50) },
      { quiz: quiz(5, 1), question: q(50, 'Rotate or stay?', 10) },
      { quiz: quiz(1), question: q(10, 'Rotate or stay?') },
    ]))).toEqual([60]);
  });

  it('two copies of one original, the original not loaded: still one', () => {
    expect(ids(distinctFootball([
      { quiz: quiz(5, 1), question: q(50, 'Rotate or stay?', 10) },
      { quiz: quiz(6, 1), question: q(60, 'Rotate or stay?', 10) },
    ]))).toEqual([50]);
  });

  it('only with no provenance at all: the same words in a retest and the quiz it retests (a legacy copy)', () => {
    expect(ids(distinctFootball([
      { quiz: quiz(5, 1), question: q(50, 'Rotate or stay?') },
      { quiz: quiz(1), question: q(10, 'Rotate or stay?') },
    ]))).toEqual([50]);
    // ...but not between quizzes with no source relationship.
    expect(ids(distinctFootball([
      { quiz: quiz(5), question: q(50, 'Rotate or stay?') },
      { quiz: quiz(1), question: q(10, 'Rotate or stay?') },
    ]))).toEqual([50, 10]);
  });

  it('two questions that are copies of different originals stay distinct, even worded alike', () => {
    expect(ids(distinctFootball([
      { quiz: quiz(5, 1), question: q(50, 'Your check?', 10) },
      { quiz: quiz(5, 1), question: q(51, 'Your check?', 11) },
    ]))).toEqual([50, 51]);
  });
});
