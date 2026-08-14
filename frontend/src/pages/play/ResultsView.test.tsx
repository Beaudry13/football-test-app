import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
