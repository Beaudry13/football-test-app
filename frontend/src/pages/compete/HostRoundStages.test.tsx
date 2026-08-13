/**
 * The projector during a round.
 *
 * The negative assertions matter most here: a screen facing the whole room
 * must not show who hasn't answered, and must not show the distribution while
 * people are still choosing.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type * as competitionApi from '../../api/competition';
import type { HostRound } from '../../api/competition';
import { HostQuestionStage, HostRevealStage } from './HostRoundStages';

const NOW = '2026-08-12T13:00:00.000+00:00';

function poll(
  overrides: Partial<competitionApi.CompetitionPollState> = {},
): competitionApi.CompetitionPollState {
  return {
    version: 4,
    status: 'QUESTION_OPEN',
    server_now: NOW,
    current_round: 2,
    question_opened_at: '2026-08-12T12:59:55.000+00:00',
    question_closes_at: '2026-08-12T13:00:15.000+00:00',
    participant_count: 22,
    answered_count: 18,
    all_in: false,
    answering_open: true,
    total_rounds: 8,
    podium_step: 0,
    ...overrides,
  };
}

function hostRound(overrides: Partial<HostRound> = {}): HostRound {
  return {
    round_index: 2,
    round_number: 3,
    total_rounds: 8,
    answered_count: 18,
    participant_count: 22,
    all_in: false,
    answering_open: true,
    question_opened_at: '2026-08-12T12:59:55.000+00:00',
    question_closes_at: '2026-08-12T13:00:15.000+00:00',
    distribution: null,
    question: {
      id: 1,
      question_text: 'Which coverage is this?',
      question_type: 'multiple_choice',
      image: null,
      options: [
        { id: 11, option_text: 'Cover 2', position: 0 },
        { id: 12, option_text: 'Cover 3', position: 1 },
        { id: 13, option_text: 'Cover 4', position: 2 },
      ],
    },
    ...overrides,
  };
}

describe('the question stage', () => {
  it('shows the round, the question and lettered options', () => {
    render(<HostQuestionStage round={hostRound()} poll={poll()} />);

    expect(screen.getByText('Round 3 of 8')).toBeInTheDocument();
    expect(screen.getByText('Which coverage is this?')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('Cover 2')).toBeInTheDocument();
  });

  it('shows a count answered, and never who has not answered', () => {
    render(<HostQuestionStage round={hostRound()} poll={poll()} />);

    expect(screen.getByText('18')).toBeInTheDocument();
    expect(screen.getByText('/ 22')).toBeInTheDocument();
    expect(screen.getByText('Answered')).toBeInTheDocument();
  });

  it('does NOT show the distribution while people are answering', () => {
    // Even if a distribution somehow arrived, the answering stage must not
    // render it - seeing the room's choices would steer the room.
    render(
      <HostQuestionStage
        round={hostRound({
          distribution: [
            { option_id: 11, option_text: 'Cover 2', count: 14, is_correct_answer: true },
          ],
        })}
        poll={poll()}
      />,
    );

    expect(screen.queryByText('14')).not.toBeInTheDocument();
    expect(screen.queryByText(/correct/i)).not.toBeInTheDocument();
  });

  it('renders a live countdown with an accessible progress role', () => {
    render(<HostQuestionStage round={hostRound()} poll={poll()} />);
    expect(screen.getByRole('progressbar', { name: /time remaining/i })).toBeInTheDocument();
  });

  it('holds the room on ALL IN when everyone has answered early', () => {
    render(
      <HostQuestionStage
        round={hostRound()}
        poll={poll({ all_in: true, answered_count: 22 })}
      />,
    );

    expect(screen.getByText(/all in · answers locked/i)).toBeInTheDocument();
    // The timer stops being the thing to watch.
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('holds the room on ANSWERS LOCKED when the clock ran out', () => {
    render(
      <HostQuestionStage
        round={hostRound()}
        // The clock, not a flag: the window is shut because the deadline has
        // passed, which is what the projector actually has to reflect.
        poll={poll({
          server_now: '2026-08-12T13:00:20.000+00:00',
          answering_open: false,
        })}
      />,
    );

    expect(screen.getByText(/^answers locked$/i)).toBeInTheDocument();
    // Not "all in" - not everybody answered, and the wording should not lie.
    expect(screen.queryByText(/all in/i)).not.toBeInTheDocument();
  });

  it('renders the 3-2-1 before the question opens', () => {
    render(
      <HostQuestionStage
        round={hostRound({
          question_opened_at: '2026-08-12T13:00:02.000+00:00',
          question_closes_at: '2026-08-12T13:00:22.000+00:00',
        })}
        poll={poll()}
      />,
    );

    expect(screen.getByText(/get ready/i)).toBeInTheDocument();
    expect(screen.queryByText('Which coverage is this?')).not.toBeInTheDocument();
  });

  it('shows a question image when present', () => {
    render(
      <HostQuestionStage
        round={hostRound({
          question: {
            ...hostRound().question,
            image: { image_url: '/uploads/x.png', annotations: [], canvas_width: 900 },
          },
        })}
        poll={poll()}
      />,
    );

    expect(screen.getByAltText('Question image')).toBeInTheDocument();
  });
});

describe('the reveal stage', () => {
  const revealed = hostRound({
    answering_open: false,
    question: {
      ...hostRound().question,
      correct_option_id: 11,
      answer_explanation: 'Two deep safeties take away the seams.',
      options: [
        { id: 11, option_text: 'Cover 2', position: 0, is_correct_answer: true },
        { id: 12, option_text: 'Cover 3', position: 1, is_correct_answer: false },
        { id: 13, option_text: 'Cover 4', position: 2, is_correct_answer: false },
      ],
    },
    distribution: [
      { option_id: 11, option_text: 'Cover 2', count: 16, is_correct_answer: true },
      { option_id: 12, option_text: 'Cover 3', count: 4, is_correct_answer: false },
      { option_id: 13, option_text: 'Cover 4', count: 2, is_correct_answer: false },
    ],
  });

  it('marks the correct answer with a word, not colour alone', () => {
    render(<HostRevealStage round={revealed} />);
    expect(screen.getByText(/✓ Correct/)).toBeInTheDocument();
  });

  it('shows the distribution across every option', () => {
    render(<HostRevealStage round={revealed} />);

    expect(screen.getByText('16')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    // Including one nobody picked.
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('makes the explanation a major element of the teaching screen', () => {
    render(<HostRevealStage round={revealed} />);

    expect(screen.getByText('Two deep safeties take away the seams.')).toBeInTheDocument();
    expect(screen.getByText('Why')).toBeInTheDocument();
  });

  it('renders cleanly when a question has no explanation', () => {
    render(
      <HostRevealStage
        round={{
          ...revealed,
          question: { ...revealed.question, answer_explanation: null },
        }}
      />,
    );

    expect(screen.queryByText('Why')).not.toBeInTheDocument();
    expect(screen.getByText('Which coverage is this?')).toBeInTheDocument();
  });

  it('names nobody', () => {
    const { container } = render(<HostRevealStage round={revealed} />);
    // Counts, never who chose what.
    expect(container.textContent).not.toMatch(/Ada|Grace|Alan/);
  });
});
