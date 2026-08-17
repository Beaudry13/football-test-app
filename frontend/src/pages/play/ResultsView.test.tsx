import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../../components/drawing/DrawingViewer', () => ({
  // jsdom cannot paint a canvas, so the real viewer is replaced by a probe
  // that records WHICH image and document it was handed - which is the part
  // that could silently go wrong.
  DrawingViewer: ({ imageUrl, alt }: { imageUrl: string; alt: string }) => (
    <div data-testid="drawing-viewer" data-image-url={imageUrl} aria-label={alt} />
  ),
}));

import { ResultsView } from './ResultsView';
import type { PlayerResultsResponse } from '../../api/types';

/** What a PLAYER is told about an excluded question.
 *
 * The rule is the same honesty rule the practice feedback follows: never show
 * a verdict Peira does not have. An excluded question carries `is_correct:
 * null` exactly as an ungraded one does, so reading the null alone would tell
 * a player their coach is still marking something nobody is marking.
 */

function results(overrides: Partial<PlayerResultsResponse['answers'][0]>): PlayerResultsResponse {
  return {
    quiz_title: 'Week 1 Prep',
    player_name: 'Jordan Smith',
    submitted_at: '2026-01-01T00:05:00Z',
    answers: [
      {
        question_id: 10,
        question_number: 1,
        question_text: 'Is this cover 2?',
        question_type: 'true_false',
        your_answer: 'False',
        correct_answer: 'True',
        is_correct: false,
        is_excluded: false,
        coach_feedback: null,
        graded_at: null,
        ...overrides,
      },
    ],
  };
}

describe('ResultsView', () => {
  it('shows a neutral excluded state instead of a verdict', () => {
    render(<ResultsView results={results({ is_excluded: true, is_correct: null, correct_answer: null })} />);

    expect(screen.getByText('Excluded from scoring')).toBeInTheDocument();
    expect(screen.queryByText('Correct')).not.toBeInTheDocument();
    expect(screen.queryByText('Incorrect')).not.toBeInTheDocument();
    // And NOT confused with an answer still awaiting a coach.
    expect(screen.queryByText('Pending review')).not.toBeInTheDocument();
  });

  it('still shows the player their own answer', () => {
    render(<ResultsView results={results({ is_excluded: true, is_correct: null, correct_answer: null })} />);

    // Exclusion sets a question aside; it does not erase what they wrote.
    expect(screen.getByText(/Your answer:/)).toHaveTextContent('False');
  });

  it('explains what happened in plain language', () => {
    render(<ResultsView results={results({ is_excluded: true, is_correct: null, correct_answer: null })} />);

    expect(screen.getByText(/coach removed this question from scoring/i)).toBeInTheDocument();
  });

  it('does not show the correct answer for an excluded question', () => {
    // Showing it next to a neutral chip invites the player to score it
    // themselves, which is the confusion exclusion exists to remove.
    render(<ResultsView results={results({ is_excluded: true, is_correct: null, correct_answer: null })} />);

    expect(screen.queryByText(/Correct answer:/)).not.toBeInTheDocument();
  });

  it('leaves an ordinary answer completely unchanged', () => {
    render(<ResultsView results={results({})} />);

    expect(screen.getByText('Incorrect')).toBeInTheDocument();
    expect(screen.getByText(/Correct answer:/)).toHaveTextContent('True');
    expect(screen.queryByText('Excluded from scoring')).not.toBeInTheDocument();
  });

  it('still shows coach feedback on an excluded question', () => {
    render(
      <ResultsView
        results={results({
          is_excluded: true,
          is_correct: null,
          correct_answer: null,
          coach_feedback: 'Good thinking anyway',
        })}
      />,
    );

    expect(screen.getByText('Good thinking anyway')).toBeInTheDocument();
  });
});

/** Draw Response Phase C - the player sees their drawing, not the words
 * "Drawing submitted".
 *
 * The same DrawingViewer the coach uses, over the same delivered image. The
 * viewer is mocked here because it paints to a canvas that jsdom cannot
 * render - what these tests pin is WHICH image and WHICH document reach it,
 * which is the part that could silently go wrong. */
describe('a Draw Response answer', () => {
  const drawingDoc = {
    format: 'peira.drawing',
    version: 1,
    source: { image_id: '77' },
    coordinate_width: 1200,
    coordinate_height: 800,
    strokes: [{ id: 's1', tool: 'pen', color: '#f00', width: 4, points: [1, 2, 3, 4], order: 0 }],
  };

  it('renders the drawing over the DELIVERED image', () => {
    render(
      <ResultsView
        results={results({
          question_type: 'draw_response',
          your_answer: 'Drawing submitted',
          drawing: { document: drawingDoc, image_url: '/uploads/preserved-old.png' },
        })}
      />,
    );

    // Matched on the PATH, not the whole string: the url goes through
    // resolveMediaUrl, which prefixes the API host. What matters is that the
    // preserved image is the one handed to the viewer.
    const viewer = screen.getByTestId('drawing-viewer');
    expect(viewer.getAttribute('data-image-url')).toContain('/uploads/preserved-old.png');
  });

  it('shows the drawing instead of the "Drawing submitted" text', () => {
    render(
      <ResultsView
        results={results({
          question_type: 'draw_response',
          your_answer: 'Drawing submitted',
          drawing: { document: drawingDoc, image_url: '/uploads/film.png' },
        })}
      />,
    );

    expect(screen.getByTestId('drawing-viewer')).toBeInTheDocument();
    expect(screen.queryByText(/Drawing submitted/)).not.toBeInTheDocument();
  });

  it('keeps the drawing visible when the question was excluded from scoring', () => {
    // Exclusion sets a question aside; it does not erase the evidence.
    render(
      <ResultsView
        results={results({
          question_type: 'draw_response',
          is_excluded: true,
          is_correct: null,
          drawing: { document: drawingDoc, image_url: '/uploads/film.png' },
        })}
      />,
    );

    expect(screen.getByTestId('drawing-viewer')).toBeInTheDocument();
    expect(screen.getByText('Excluded from scoring')).toBeInTheDocument();
  });

  it('degrades to the text line when there is no drawing', () => {
    // A Draw Response the player skipped. Mounting a viewer over nothing would
    // be worse than saying plainly that there is no answer.
    render(
      <ResultsView
        results={results({ question_type: 'draw_response', your_answer: null, drawing: null })}
      />,
    );

    expect(screen.queryByTestId('drawing-viewer')).not.toBeInTheDocument();
    expect(screen.getByText('No answer')).toBeInTheDocument();
  });

  it('leaves a non-drawing answer exactly as it was', () => {
    render(<ResultsView results={results({ your_answer: 'B gap' })} />);

    expect(screen.queryByTestId('drawing-viewer')).not.toBeInTheDocument();
    expect(screen.getByText(/B gap/)).toBeInTheDocument();
  });

  /** MULTI-SELECT M4. A set answer arrives as one already-joined line, so this
   *  page needed no branch, no list rendering and no new control - which is
   *  the point, and is what this pins. The joining, the delivered wording and
   *  the delivered order are the server's job and are tested there. */
  it('shows a whole selection set as one line, with nothing added around it', () => {
    render(
      <ResultsView
        results={results({
          question_type: 'multiple_choice',
          your_answer: 'Mike; Nickel; Boundary Safety',
          correct_answer: 'Mike; Nickel; Boundary Safety',
          is_correct: true,
        })}
      />,
    );

    expect(screen.getByText(/Mike; Nickel; Boundary Safety/)).toBeInTheDocument();
    // No per-selection breakdown, no extra affordance: a set answer reads
    // exactly like an ordinary multiple-choice one.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});
