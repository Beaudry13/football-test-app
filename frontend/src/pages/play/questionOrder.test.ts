import { describe, expect, it } from 'vitest';
import { orderQuestions } from './questionOrder';

const q = (id: number) => ({ id, question_text: `Q${id}` });

describe('orderQuestions', () => {
  it('leaves the authored order alone when there is no frozen order', () => {
    const questions = [q(1), q(2), q(3)];
    expect(orderQuestions(questions, undefined)).toBe(questions);
    expect(orderQuestions(questions, [])).toBe(questions);
  });

  it('arranges questions by the frozen order', () => {
    expect(orderQuestions([q(1), q(2), q(3)], [3, 1, 2]).map((x) => x.id)).toEqual([3, 1, 2]);
  });

  it('skips an id whose question no longer exists', () => {
    // The two payloads arrive from DIFFERENT requests, so a quiz edited in
    // between can leave a stale id in the order.
    expect(orderQuestions([q(1), q(3)], [3, 2, 1]).map((x) => x.id)).toEqual([3, 1]);
  });

  it('appends a question the frozen order never knew about', () => {
    expect(orderQuestions([q(1), q(2), q(9)], [2, 1]).map((x) => x.id)).toEqual([2, 1, 9]);
  });

  it('never duplicates a question even if the order repeats an id', () => {
    expect(orderQuestions([q(1), q(2)], [1, 1, 2]).map((x) => x.id)).toEqual([1, 2]);
  });

  it('handles zero and one question', () => {
    expect(orderQuestions([], [1, 2])).toEqual([]);
    expect(orderQuestions([q(4)], [4]).map((x) => x.id)).toEqual([4]);
  });
});
