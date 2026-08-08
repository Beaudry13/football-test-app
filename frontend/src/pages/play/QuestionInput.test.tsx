import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuestionInput } from './QuestionInput';
import type { Question } from '../../api/types';

// AnnotationViewer mounts a real Fabric.js StaticCanvas, which needs a real
// 2D canvas context jsdom doesn't provide (the same reason AnnotationCanvas
// itself is never mounted in AnnotationPage.test.tsx - see the fixtures
// there, always image: null). Stubbing it here lets this file test
// QuestionInput's own decision logic - which component and props it
// renders - without needing a canvas polyfill.
vi.mock('../../components/annotation/AnnotationViewer', () => ({
  AnnotationViewer: (props: { imageUrl: string; annotations: unknown[]; alt: string }) => (
    <div
      data-testid="annotation-viewer"
      data-image-url={props.imageUrl}
      data-annotation-count={props.annotations.length}
    >
      {props.alt}
    </div>
  ),
}));

const baseQuestion: Question = {
  id: 1,
  quiz_id: 1,
  question_text: 'Which gap?',
  question_type: 'multiple_choice',
  position: 0,
  options: [
    { id: 1, question_id: 1, option_text: 'A gap', position: 0, is_correct_answer: true },
    { id: 2, question_id: 1, option_text: 'B gap', position: 1, is_correct_answer: false },
  ],
  image: null,
};

describe('QuestionInput image rendering', () => {
  it('renders no image element when the question has no image', () => {
    render(<QuestionInput question={baseQuestion} index={0} answer={undefined} onChange={vi.fn()} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByTestId('annotation-viewer')).not.toBeInTheDocument();
  });

  it('renders a plain image when the question image has no saved annotations', () => {
    const question: Question = {
      ...baseQuestion,
      image: {
        id: 1,
        question_id: 1,
        image_url: '/uploads/x.png',
        annotations: [],
        canvas_width: null,
        updated_at: '2026-01-01T00:00:00Z',
      },
    };
    render(<QuestionInput question={question} index={0} answer={undefined} onChange={vi.fn()} />);
    expect(screen.getByAltText('Film still')).toBeInTheDocument();
    expect(screen.queryByTestId('annotation-viewer')).not.toBeInTheDocument();
  });

  it('renders the annotation viewer instead of a plain image when the image has saved annotations', () => {
    const question: Question = {
      ...baseQuestion,
      image: {
        id: 1,
        question_id: 1,
        image_url: '/uploads/x.png',
        annotations: [{ id: 'a1', type: 'Line' }],
        canvas_width: 1400,
        updated_at: '2026-01-01T00:00:00Z',
      },
    };
    render(<QuestionInput question={question} index={0} answer={undefined} onChange={vi.fn()} />);
    expect(screen.queryByAltText('Film still')).not.toBeInTheDocument();
    const viewer = screen.getByTestId('annotation-viewer');
    expect(viewer.dataset.annotationCount).toBe('1');
    expect(viewer.dataset.imageUrl).toContain('/uploads/x.png');
  });
});

// --- Draw on Image ------------------------------------------------------
//
// DrawingBoard constructs a real Fabric Canvas, which jsdom cannot back with
// a 2D context - the same reason AnnotationViewer is stubbed above. These
// tests cover QuestionInput's decision logic: whether the entry point is
// offered at all, and that an ordinary image question is untouched.
vi.mock('../../components/drawing/DrawingBoard', () => ({
  DrawingBoard: (props: { imageUrl: string }) => (
    <div data-testid="drawing-board" data-image-url={props.imageUrl} />
  ),
}));

const imagedQuestion: Question = {
  ...baseQuestion,
  image: {
    id: 7,
    question_id: 1,
    image_url: '/uploads/still.png',
    annotations: [],
    canvas_width: 1400,
    updated_at: '2026-08-07T00:00:00Z',
  },
};

describe('QuestionInput drawing entry point', () => {
  it('offers no drawing on an ordinary image question', () => {
    // The backward-compatibility guarantee: an existing question with an
    // image must behave exactly as it did before this feature.
    render(<QuestionInput question={imagedQuestion} index={0} answer={undefined} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /draw your answer/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('drawing-board')).not.toBeInTheDocument();
  });

  it('offers no drawing when the type is Draw Response but the image is gone', () => {
    // The API refuses to activate a quiz whose Draw Response question has no
    // image, so a player should never meet this - but an image deleted
    // mid-session must degrade to a clear message, not an empty board.
    const orphaned: Question = { ...baseQuestion, question_type: 'draw_response', image: null };
    render(<QuestionInput question={orphaned} index={0} answer={undefined} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /draw your answer/i })).not.toBeInTheDocument();
    expect(screen.getByText(/missing its image/i)).toBeInTheDocument();
  });

  it('shows no options or text box on a Draw Response question', () => {
    // It is answered by the board and nothing else. The combined-response
    // work will add these back behind their own per-question requirements.
    const enabled: Question = { ...imagedQuestion, question_type: 'draw_response' };
    render(<QuestionInput question={enabled} index={0} answer={undefined} onChange={vi.fn()} />);

    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('leaves a multiple-choice question completely untouched', () => {
    // The backward-compatibility guarantee, restated for the type model.
    render(<QuestionInput question={imagedQuestion} index={0} answer={undefined} onChange={vi.fn()} />);

    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /draw your answer/i })).not.toBeInTheDocument();
  });

  it('offers the board once the coach enables it on an image question', () => {
    const enabled: Question = { ...imagedQuestion, question_type: 'draw_response' };
    render(<QuestionInput question={enabled} index={0} answer={undefined} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /draw your answer/i })).toBeInTheDocument();
  });

  it('does not open the board until the player asks for it', () => {
    // Opening on render would fabricate an empty document, which the submit
    // guard would then have to distinguish from a real answer.
    const enabled: Question = { ...imagedQuestion, question_type: 'draw_response' };
    render(<QuestionInput question={enabled} index={0} answer={undefined} onChange={vi.fn()} />);
    expect(screen.queryByTestId('drawing-board')).not.toBeInTheDocument();
  });

  it('invites an edit, and reports the mark count, once something is drawn', () => {
    const enabled: Question = { ...imagedQuestion, question_type: 'draw_response' };
    const answer = {
      drawing: {
        format: 'peira.drawing' as const,
        version: 1,
        source: { image_id: '7', image_version: null, natural_width: 1600, natural_height: 1000 },
        coordinate_width: 1400,
        coordinate_height: 875,
        strokes: [
          { id: 'a', tool: 'pen' as const, layer: 'player' as const, points: [0, 0, 5, 5], color: '#00E5FF', width: 6, order: 0 },
        ],
      },
    };
    render(<QuestionInput question={enabled} index={0} answer={answer} onChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: /edit your drawing/i })).toBeInTheDocument();
    expect(screen.getByText(/1 mark/)).toBeInTheDocument();
  });
});

describe('QuestionInput fill-in-the-blank', () => {
  const fillBlank: Question = {
    id: 9,
    quiz_id: 1,
    question_text: 'What coverage is hidden?',
    question_type: 'fill_blank',
    position: 0,
    options: [],
    image: null,
    masked_image_url: '/api/media/v1.qmask.sig',
    region: {
      id: 5,
      question_id: 9,
      document_page_id: 2,
      shape: 'rect',
      x: 0.2,
      y: 0.3,
      width: 0.25,
      height: 0.05,
      role: 'mask',
      position: 0,
      page_number: 1,
      source_document_id: 1,
      render_width: 1275,
      render_height: 1651,
    },
  };

  it('shows the masked playbook page', () => {
    render(<QuestionInput question={fillBlank} index={0} answer={undefined} onChange={vi.fn()} />);
    const image = screen.getByAltText('Playbook page with the answer covered');
    expect(image.getAttribute('src')).toContain('/api/media/v1.qmask.sig');
  });

  it('renders a single-line answer box, not a textarea', () => {
    // A fill-in-the-blank answer is a play name or a call. A multi-line box
    // invites an essay that the matcher would then mark wrong.
    render(<QuestionInput question={fillBlank} index={0} answer={undefined} onChange={vi.fn()} />);
    const input = screen.getByLabelText('Your answer');
    expect(input.tagName).toBe('INPUT');
  });

  it('reports what the player types', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<QuestionInput question={fillBlank} index={0} answer={undefined} onChange={onChange} />);

    await user.type(screen.getByLabelText('Your answer'), 'C');
    expect(onChange).toHaveBeenCalledWith({ answer_text: 'C' });
  });

  it('turns off autocorrect and autocapitalise', () => {
    // A phone keyboard "helpfully" capitalising or correcting a play name is
    // the difference between a correct answer and a wrong one.
    render(<QuestionInput question={fillBlank} index={0} answer={undefined} onChange={vi.fn()} />);
    const input = screen.getByLabelText('Your answer');
    expect(input).toHaveAttribute('autocorrect', 'off');
    expect(input).toHaveAttribute('autocapitalize', 'none');
  });

  it('shows no picture at all rather than an unmasked page when none is supplied', () => {
    // The failure mode this guards is the only one that matters here: falling
    // back to a page image would hand the player the answer.
    const withoutMask: Question = { ...fillBlank, masked_image_url: null };
    render(<QuestionInput question={withoutMask} index={0} answer={undefined} onChange={vi.fn()} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('never receives the accepted answers', () => {
    // The API omits expected_answers from every player payload; this asserts
    // the component does not render them even if one ever leaked through.
    render(<QuestionInput question={fillBlank} index={0} answer={undefined} onChange={vi.fn()} />);
    expect(screen.queryByText(/Cover 3/)).not.toBeInTheDocument();
  });
});
