/** PREVIEW MUST SHOW WHAT THE PLAYER WILL SEE.
 *
 * A playbook question has no `question_images` row - the masked render IS its
 * picture, and it arrives as `masked_image_url`. Preview builds its screen
 * from the coach payload, which used to carry no picture at all, so every
 * playbook question previewed as an empty card while the real attempt was
 * fine. The backend half of the fix is covered by
 * `test_preview_masked_media.py`; this is the half that proves the shared
 * question renderer actually puts it on the screen.
 *
 * THE EMPTY RECTANGLE HAD TWO CAUSES and this file pins both. With the
 * picture missing, the only thing left on the card was the Fill in the Blank
 * answer field - a single-line <input> that reused the written-answer class
 * and so carried a 7em minimum height. A tall empty bordered box, which is
 * exactly how it was reported.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuestionInput } from '../play/QuestionInput';
import type { Question } from '../../api/types';

vi.mock('../../components/annotation/AnnotationViewer', () => ({
  AnnotationViewer: (props: { imageUrl: string; alt: string }) => (
    <canvas role="img" aria-label={props.alt} data-url={props.imageUrl} />
  ),
}));

/** A playbook question exactly as the API describes it: a region, no image of
 *  its own, and the masked render as its only picture. */
function playbookQuestion(overrides: Record<string, unknown> = {}): Question {
  return {
    id: 18,
    quiz_id: 1,
    question_text: 'WHAT COVERAGE IS THIS?',
    question_type: 'fill_blank',
    position: 17,
    image: null,
    options: [],
    expected_answers: ['Cover 3'],
    region: {
      id: 5,
      question_id: 18,
      document_page_id: 99,
      shape: 'rect',
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.15,
      role: 'mask',
      position: 0,
      page_number: 12,
      source_document_id: 3,
      render_width: 1275,
      render_height: 1650,
    },
    masked_image_url: '/api/media/signed-token',
    ...overrides,
  } as unknown as Question;
}

function renderQuestion(question: Question) {
  return render(
    <QuestionInput question={question} index={17} answer={undefined} onChange={vi.fn()} />,
  );
}

describe('a playbook question', () => {
  it('shows the masked page', () => {
    renderQuestion(playbookQuestion());

    const image = screen.getByAltText(/playbook page with the answer covered/i);
    expect(image).toBeInTheDocument();
    expect(image.getAttribute('src')).toContain('/api/media/signed-token');
  });

  it('shows the picture on the FIRST render, with no second pass', () => {
    // Asserted synchronously, with no waitFor and no act beyond the render
    // itself: the picture must be part of the first paint, not something that
    // arrives after a state settle.
    const { container } = renderQuestion(playbookQuestion());

    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('renders NOTHING to look at when the payload omits the picture', () => {
    // THE BUG, pinned from the client side. If the backend ever stops
    // attaching the URL, this is what a coach would meet again.
    const { container } = renderQuestion(
      playbookQuestion({ masked_image_url: undefined }),
    );

    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelectorAll('canvas')).toHaveLength(0);
  });

  it('never falls back to an unmasked page', () => {
    // There is deliberately no fallback: a region question with no masked URL
    // must render no picture rather than reach for the raw page.
    const { container } = renderQuestion(
      playbookQuestion({ masked_image_url: undefined }),
    );

    const html = container.innerHTML;
    expect(html).not.toContain('document_page');
    expect(html).not.toContain('/pages/');
  });
});

describe('the Fill in the Blank answer field', () => {
  it('is a concise single-line field, not a written-response box', () => {
    const { container } = renderQuestion(playbookQuestion());

    const field = container.querySelector('input[type="text"]');
    expect(field).toBeInTheDocument();
    // Both classes: it keeps the shared border/padding/16px-font treatment and
    // adds only the height correction.
    expect(field!.className).toMatch(/writtenAnswer/);
    expect(field!.className).toMatch(/blankAnswer/);
  });

  it('leaves Written Response alone', () => {
    // The tall box is CORRECT for an essay. This is the regression the
    // narrow fix exists to avoid.
    const { container } = renderQuestion(
      playbookQuestion({
        question_type: 'written',
        masked_image_url: undefined,
        region: undefined,
      }),
    );

    const field = container.querySelector('textarea');
    expect(field).toBeInTheDocument();
    expect(field!.className).toMatch(/writtenAnswer/);
    expect(field!.className).not.toMatch(/blankAnswer/);
  });
});

describe('ordinary questions are untouched', () => {
  it('an uploaded image still renders from its own url', () => {
    renderQuestion(
      playbookQuestion({
        question_type: 'multiple_choice',
        masked_image_url: undefined,
        region: undefined,
        image: {
          id: 7,
          question_id: 18,
          image_url: '/uploads/still.png',
          canvas_width: 900,
          annotations: [],
        },
        options: [{ id: 1, question_id: 18, option_text: 'Cover 3', position: 0 }],
      }),
    );

    expect(screen.getByAltText('Film still').getAttribute('src')).toContain('/uploads/still.png');
  });
});
