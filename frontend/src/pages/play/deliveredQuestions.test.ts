/** THE ATTEMPT VERSION INVARIANT - the client half.
 *
 * The server enforces the invariant by serving `/play/start` the attempt's own
 * snapshot. But the client holds a SECOND, LIVE copy: `/validate-code` fetched
 * the quiz before the player picked a name, and a mid-quiz refresh re-runs it.
 * So after a coach correction the browser is holding both versions at once,
 * and `applyDeliveredContent` is what decides which one the player reads.
 *
 * These tests are written against a coach having ALREADY corrected the quiz -
 * live and delivered deliberately disagree on every field - because a fixture
 * where the two agree would pass no matter which one won.
 */
import { describe, expect, it } from 'vitest';
import { applyDeliveredContent } from './deliveredQuestions';
import type { DeliveredPlayerQuestion, Question } from '../../api/types';

const liveQuestion = (over: Partial<Question> = {}): Question =>
  ({
    id: 1,
    quiz_id: 9,
    question_text: 'NEW text (coach corrected this)',
    question_type: 'multiple_choice',
    position: 0,
    options: [
      { id: 11, question_id: 1, option_text: 'NEW option A', position: 0 },
      { id: 12, question_id: 1, option_text: 'NEW option B', position: 1 },
    ],
    image: {
      id: 500,
      question_id: 1,
      image_url: '/new.png',
      canvas_width: 1200,
      annotations: [{ kind: 'new' }],
      updated_at: '2026-08-15T00:00:00Z',
    },
    ...over,
  }) as unknown as Question;

const delivered = (over: Partial<DeliveredPlayerQuestion> = {}): DeliveredPlayerQuestion => ({
  id: 1,
  question_text: 'OLD text (what the player was given)',
  question_type: 'multiple_choice',
  options: [
    { id: 11, option_text: 'OLD option A' },
    { id: 12, option_text: 'OLD option B' },
  ],
  image: {
    id: 400,
    image_url: '/preserved-old.png',
    canvas_width: 800,
    annotations: [{ kind: 'old' }],
  },
  ...over,
});

describe('applyDeliveredContent', () => {
  it('shows the DELIVERED question text, not the corrected live one', () => {
    const [merged] = applyDeliveredContent([liveQuestion()], [delivered()]);

    expect(merged.question_text).toBe('OLD text (what the player was given)');
  });

  it('shows the DELIVERED option text', () => {
    const [merged] = applyDeliveredContent([liveQuestion()], [delivered()]);

    expect(merged.options?.map((o) => o.option_text)).toEqual(['OLD option A', 'OLD option B']);
  });

  it('keeps the delivered option IDS, so a saved answer still resolves', () => {
    const [merged] = applyDeliveredContent([liveQuestion()], [delivered()]);

    expect(merged.options?.map((o) => o.id)).toEqual([11, 12]);
  });

  it('shows the DELIVERED picture and coordinate space', () => {
    // canvas_width especially: rendering old annotations at the new width
    // would move every shape on the image. See CLAUDE.md, bite #3.
    const [merged] = applyDeliveredContent([liveQuestion()], [delivered()]);

    expect(merged.image?.image_url).toBe('/preserved-old.png');
    expect(merged.image?.canvas_width).toBe(800);
    expect(merged.image?.annotations).toEqual([{ kind: 'old' }]);
  });

  it('binds to the DELIVERED image id, not the live one', () => {
    // PHASE A. A Draw Response document records this as `source.image_id`.
    // Taking it from the live question would bind a drawing to whatever the
    // coach last uploaded rather than to the picture under the strokes - and
    // the server now refuses that mismatch outright.
    const [merged] = applyDeliveredContent([liveQuestion()], [delivered()]);

    expect((merged.image as unknown as { id: number }).id).toBe(400);
  });

  it('falls back to the live image id when the snapshot predates Phase A', () => {
    const old = delivered();
    (old.image as unknown as { id: number | null }).id = null;

    const [merged] = applyDeliveredContent([liveQuestion()], [old]);

    expect((merged.image as unknown as { id: number }).id).toBe(500);
  });

  it('keeps the live updated_at, which the drawing layer caches against', () => {
    const [merged] = applyDeliveredContent([liveQuestion()], [delivered()]);

    expect((merged.image as unknown as { updated_at: string }).updated_at).toBe(
      '2026-08-15T00:00:00Z',
    );
  });

  it('shows the DELIVERED question type', () => {
    // The measured corruption bug: a live type change made an answered
    // question render through the wrong input.
    const [merged] = applyDeliveredContent(
      [liveQuestion({ question_type: 'written' as Question['question_type'] })],
      [delivered()],
    );

    expect(merged.question_type).toBe('multiple_choice');
  });

  it('falls back to the live questions for an attempt with NO snapshot', () => {
    // A pre-Phase-1 attempt. This is a COMPATIBILITY FALLBACK, not history.
    const live = [liveQuestion()];

    expect(applyDeliveredContent(live, undefined)).toBe(live);
    expect(applyDeliveredContent(live, [])).toBe(live);
  });

  it('renders a delivered question whose live row has been deleted', () => {
    const [merged] = applyDeliveredContent([], [delivered()]);

    expect(merged.question_text).toBe('OLD text (what the player was given)');
    expect(merged.image?.image_url).toBe('/preserved-old.png');
  });

  it('drops a question the attempt was never delivered', () => {
    // The coach added question 2 after this attempt started. It is not in the
    // snapshot, so this player never sees it - and /submit agrees, holding
    // them only to the delivered set.
    const merged = applyDeliveredContent(
      [liveQuestion(), liveQuestion({ id: 2, question_text: 'ADDED LATER' })],
      [delivered()],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(1);
  });

  it('prefers the live masked url for a region-backed question', () => {
    // The snapshot does not record region geometry, so the signed masked
    // render is the one seam that legitimately comes from live data.
    const [merged] = applyDeliveredContent(
      [liveQuestion()],
      [delivered({ masked_image_url: '/api/media/signed-token' })],
    );

    expect(
      (merged as unknown as { masked_image_url: string | null }).masked_image_url,
    ).toBe('/api/media/signed-token');
  });

  it('never leaks an answer-key field onto the merged question', () => {
    // The player payload carries no correctness flag; merging must not
    // resurrect one from the live options either.
    const [merged] = applyDeliveredContent([liveQuestion()], [delivered()]);

    for (const option of merged.options ?? []) {
      expect(option).not.toHaveProperty('is_correct_answer');
    }
    expect(JSON.stringify(merged)).not.toContain('is_correct_answer');
  });
});
