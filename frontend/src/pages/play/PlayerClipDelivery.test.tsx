import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { applyDeliveredContent } from './deliveredQuestions';
import { QuestionInput } from './QuestionInput';
import type { DeliveredPlayerQuestion, Question } from '../../api/types';

/** THE PLAYER MUST ACTUALLY SEE THE FILM.
 *
 * REPORTED FROM A REAL PHONE: an activated quiz reached the player, the
 * question text and the answer choices rendered - and the recording was
 * completely absent. No video, no poster, nothing to press.
 *
 * THE CAUSE WAS THE MERGE, NOT THE SERVER. `/play/start` sends the clip with a
 * signed URL minted for that access code. `applyDeliveredContent` rebuilt each
 * question from the delivered payload but only copied id, text, type, options,
 * image and masked_image_url - never `clip`. So the clip fell through to the
 * live `/validate-code` copy, which is serialized with
 * `with_urls=include_correct_answers` - FALSE for a player. That copy carries
 * clip METADATA and no `url` at all, so the renderer produced a <video> with
 * no source.
 *
 * It is also why Preview-as-player looked fine: the coach's payload is built
 * with urls and never goes through this merge. A test that only exercised
 * preview would have passed throughout.
 *
 * These cover both halves - the merge keeping the URL, and the real player
 * renderer putting it on a <video> - so removing clip support from either end
 * fails here.
 */

const PLAYER_CLIP_URL = '/api/media/v1.player-signed-token';
const PLAYER_POSTER_URL = '/api/media/v1.player-poster-token';

/** The live copy from /validate-code: metadata, and DELIBERATELY no urls. */
const liveQuestion = (): Question =>
  ({
    id: 42,
    quiz_id: 7,
    question_text: 'What happens after the motion?',
    question_type: 'true_false',
    position: 0,
    options: [
      { id: 1, question_id: 42, option_text: 'True', position: 0 },
      { id: 2, question_id: 42, option_text: 'False', position: 1 },
    ],
    image: null,
    needs_image: false,
    clip: {
      id: 9,
      question_id: 42,
      content_type: 'video/mp4',
      duration_ms: 8000,
      width: 1920,
      height: 1080,
      has_poster: true,
    },
  }) as unknown as Question;

/** The delivered copy from /play/start: the only one with a playable URL. */
const deliveredQuestion = (
  over: Record<string, unknown> = {},
): DeliveredPlayerQuestion =>
  ({
    id: 42,
    question_text: 'What happens after the motion?',
    question_type: 'true_false',
    options: [
      { id: 1, option_text: 'True' },
      { id: 2, option_text: 'False' },
    ],
    image: null,
    clip: {
      url: PLAYER_CLIP_URL,
      poster_url: PLAYER_POSTER_URL,
      content_type: 'video/mp4',
      width: 1920,
      height: 1080,
      decision_point_ms: null,
      ...over,
    },
  }) as unknown as DeliveredPlayerQuestion;

describe('the delivered clip survives the merge', () => {
  it('keeps the signed URL, which only the delivered payload has', () => {
    // THE REGRESSION. Without this the clip fell through to the live copy and
    // arrived with no url at all.
    const [merged] = applyDeliveredContent([liveQuestion()], [deliveredQuestion()]);
    expect(merged.clip?.url).toBe(PLAYER_CLIP_URL);
    expect(merged.clip?.poster_url).toBe(PLAYER_POSTER_URL);
  });

  it('keeps the frozen decision point rather than the live one', () => {
    const [merged] = applyDeliveredContent(
      [liveQuestion()],
      [deliveredQuestion({ decision_point_ms: 6000 })],
    );
    expect(merged.clip?.decision_point_ms).toBe(6000);
  });

  it('leaves a question with no clip alone', () => {
    const plain = { ...liveQuestion(), clip: null } as unknown as Question;
    const [merged] = applyDeliveredContent([plain], [deliveredQuestion({ url: undefined })]);
    // No delivered clip url means nothing to show; it must not invent one.
    expect(merged.clip?.url).toBeUndefined();
  });

  it('does not disturb the image path it already handled', () => {
    const withImage = {
      ...liveQuestion(),
      clip: null,
      image: { id: 3, question_id: 42, image_url: '/old.jpg', annotations: [] },
    } as unknown as Question;
    const delivered = {
      ...deliveredQuestion(),
      clip: undefined,
      image: { id: 3, image_url: '/delivered.jpg', canvas_width: 800, annotations: [] },
    } as unknown as DeliveredPlayerQuestion;

    const [merged] = applyDeliveredContent([withImage], [delivered]);
    expect(merged.image?.image_url).toBe('/delivered.jpg');
  });
});

describe('the player renderer shows the film', () => {
  function renderPlayerQuestion(question: Question) {
    const { container } = render(
      <QuestionInput
        question={question}
        index={0}
        answer={undefined}
        onChange={vi.fn()}
      />,
    );
    return container;
  }

  it('renders a video carrying the delivered source', () => {
    // The end of the reported path: what the athlete's phone actually gets.
    const [merged] = applyDeliveredContent([liveQuestion()], [deliveredQuestion()]);
    const container = renderPlayerQuestion(merged);

    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.getAttribute('src')).toContain(PLAYER_CLIP_URL);
    expect(video?.getAttribute('poster')).toContain(PLAYER_POSTER_URL);
  });

  it('renders the question text and answers alongside it', () => {
    // The screenshot showed these WITHOUT the film - all three belong together.
    const [merged] = applyDeliveredContent([liveQuestion()], [deliveredQuestion()]);
    renderPlayerQuestion(merged);

    expect(screen.getByText(/what happens after the motion/i)).toBeInTheDocument();
    expect(screen.getByText('True')).toBeInTheDocument();
    expect(screen.getByText('False')).toBeInTheDocument();
  });

  it('shows nothing rather than a broken player when there is genuinely no clip', () => {
    const plain = { ...liveQuestion(), clip: null } as unknown as Question;
    const container = renderPlayerQuestion(plain);
    expect(container.querySelector('video')).toBeNull();
  });
});
