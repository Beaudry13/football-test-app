import { render, screen } from '@testing-library/react';
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

  it('offers no drawing when the toggle is on but the image is gone', () => {
    // An image deleted between load and render, or a stale payload. Degrading
    // to an ordinary question beats opening a board with nothing behind it.
    const orphaned: Question = { ...baseQuestion, allow_drawing: true, image: null };
    render(<QuestionInput question={orphaned} index={0} answer={undefined} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /draw your answer/i })).not.toBeInTheDocument();
  });

  it('offers the board once the coach enables it on an image question', () => {
    const enabled: Question = { ...imagedQuestion, allow_drawing: true };
    render(<QuestionInput question={enabled} index={0} answer={undefined} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /draw your answer/i })).toBeInTheDocument();
  });

  it('does not open the board until the player asks for it', () => {
    // Opening on render would fabricate an empty document, which the submit
    // guard would then have to distinguish from a real answer.
    const enabled: Question = { ...imagedQuestion, allow_drawing: true };
    render(<QuestionInput question={enabled} index={0} answer={undefined} onChange={vi.fn()} />);
    expect(screen.queryByTestId('drawing-board')).not.toBeInTheDocument();
  });

  it('invites an edit, and reports the mark count, once something is drawn', () => {
    const enabled: Question = { ...imagedQuestion, allow_drawing: true };
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
