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
