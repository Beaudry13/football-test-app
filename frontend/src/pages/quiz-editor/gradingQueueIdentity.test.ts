/** The grading queue used to flatten each response down to a name.
 *
 * Two same-named players then reached the grading screen as two identical
 * strings. The queue now carries the canonical id and the jersey through, and
 * the fields that DECIDE anything - which answer, which attempt, what verdict -
 * are exactly what they were.
 */
import { describe, expect, it } from 'vitest';
import { buildGradingQueue } from './gradingQueue';
import type { PlayerResponse, Question, Quiz } from '../../api/types';

const WRITTEN = { id: 11, question_text: 'Your job?', question_type: 'written', options: [] } as unknown as Question;
const quiz = { questions: [WRITTEN] } as unknown as Pick<Quiz, 'questions'>;

const response = (
  id: number,
  answerId: number,
  over: Partial<PlayerResponse>,
): PlayerResponse =>
  ({
    id,
    quiz_id: 1,
    display_name: 'John Smith',
    player_name: 'John Smith',
    submitted_at: '2026-08-21T18:00:00Z',
    answers: [
      {
        id: answerId,
        question_id: WRITTEN.id,
        answer_text: 'Flat',
        selected_option_id: null,
        is_correct: null,
        coach_feedback: null,
        graded_at: null,
        graded_by_username: null,
      },
    ],
    ...over,
  }) as unknown as PlayerResponse;

describe('identity survives the flattening', () => {
  it('carries player_id and jersey for each canonical response', () => {
    const [question] = buildGradingQueue(
      quiz,
      [
        response(1, 101, { player_id: 21, jersey_number: '12' }),
        response(2, 102, { player_id: 22, jersey_number: '37' }),
      ],
      new Set(),
    );

    expect(question.targets.map((t) => [t.answerId, t.attemptId, t.playerId, t.jerseyNumber])).toEqual([
      [101, 1, 21, '12'],
      [102, 2, 22, '37'],
    ]);
  });

  it('a legacy response has no id and no jersey, and is still gradeable', () => {
    const [question] = buildGradingQueue(quiz, [response(3, 103, {})], new Set());

    expect(question.targets).toHaveLength(1);
    expect(question.targets[0].playerId).toBeNull();
    expect(question.targets[0].jerseyNumber).toBeNull();
    expect(question.targets[0].playerName).toBe('John Smith');
    expect(question.ungradedCount).toBe(1);
  });
});
