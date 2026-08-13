/**
 * The player's phone during a round.
 *
 * The submit flow is the important part: an optimistic lock would lie to a
 * player in exactly the case that matters most - a tap near the deadline that
 * did not arrive in time.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import * as competitionApi from '../../api/competition';
import { PlayerQuestionScreen, PlayerRevealScreen } from './PlayerRoundScreens';

vi.mock('../../api/competition', async () => {
  const actual = await vi.importActual<typeof competitionApi>('../../api/competition');
  return { ...actual, submitAnswer: vi.fn() };
});

const submit = vi.mocked(competitionApi.submitAnswer);

const NOW = '2026-08-12T13:00:00.000+00:00';

function round(overrides: Partial<competitionApi.PlayerRound> = {}): competitionApi.PlayerRound {
  return {
    round_index: 0,
    round_number: 1,
    total_rounds: 5,
    status: 'QUESTION_OPEN',
    server_now: NOW,
    // Open 5s ago, closes in 15s.
    question_opened_at: '2026-08-12T12:59:55.000+00:00',
    question_closes_at: '2026-08-12T13:00:15.000+00:00',
    answering_open: true,
    answered: false,
    selected_option_id: null,
    result: null,
    question: {
      id: 1,
      question_text: 'Which coverage is this?',
      question_type: 'multiple_choice',
      image: null,
      options: [
        { id: 11, option_text: 'Cover 2', position: 0 },
        { id: 12, option_text: 'Cover 3', position: 1 },
      ],
    },
    ...overrides,
  };
}

function renderQuestion(overrides = {}, onAnswered = vi.fn()) {
  render(
    <PlayerQuestionScreen
      round={round(overrides)}
      joinCode="ABC123"
      token="tok"
      onAnswered={onAnswered}
    />,
  );
  return onAnswered;
}

beforeEach(() => {
  vi.clearAllMocks();
  submit.mockResolvedValue({ accepted: true, locked: true, selected_option_id: 11 });
});

describe('answering', () => {
  it('shows the question and large lettered controls', () => {
    renderQuestion();
    expect(screen.getByText('Which coverage is this?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /A\s*Cover 2/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /B\s*Cover 3/ })).toBeInTheDocument();
  });

  it('sends the round and option, and nothing else', async () => {
    const user = userEvent.setup();
    renderQuestion();

    await user.click(screen.getByRole('button', { name: /Cover 2/ }));

    await waitFor(() => expect(submit).toHaveBeenCalledWith('ABC123', 'tok', 0, 11));
  });

  it('does NOT claim the answer is locked before the server says so', async () => {
    const user = userEvent.setup();
    // A request that never settles: the UI must sit in "sending", not "locked".
    submit.mockReturnValue(new Promise(() => {}));
    renderQuestion();

    await user.click(screen.getByRole('button', { name: /Cover 2/ }));

    expect(await screen.findByText(/sending/i)).toBeInTheDocument();
    expect(screen.queryByText(/answer locked/i)).not.toBeInTheDocument();
  });

  it('guards against a double tap while a request is in flight', async () => {
    const user = userEvent.setup();
    submit.mockReturnValue(new Promise(() => {}));
    renderQuestion();

    const first = screen.getByRole('button', { name: /Cover 2/ });
    await user.click(first);
    await user.click(screen.getByRole('button', { name: /Cover 3/ }));

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('tells the player honestly when the answer arrived too late', async () => {
    const user = userEvent.setup();
    submit.mockRejectedValue(
      new ApiError('too late', 409, undefined, 'answering_closed'),
    );
    renderQuestion();

    await user.click(screen.getByRole('button', { name: /Cover 2/ }));

    expect(await screen.findByText(/time.s up/i)).toBeInTheDocument();
    expect(screen.getByText(/didn.t arrive in time/i)).toBeInTheDocument();
  });

  it('offers a retry when the network fails and time remains', async () => {
    const user = userEvent.setup();
    submit.mockRejectedValue(new ApiError('offline', 0));
    renderQuestion();

    await user.click(screen.getByRole('button', { name: /Cover 2/ }));

    // Not silently lost, and not falsely locked.
    expect(await screen.findByRole('alert')).toHaveTextContent(/still have time/i);
    expect(screen.getByText(/tap to retry/i)).toBeInTheDocument();
  });

  it('treats an already-locked reply as success rather than an error', async () => {
    const user = userEvent.setup();
    submit.mockRejectedValue(new ApiError('locked', 409, undefined, 'answer_locked'));
    const onAnswered = renderQuestion({}, vi.fn());

    await user.click(screen.getByRole('button', { name: /Cover 2/ }));

    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  });
});

describe('locked and expired states', () => {
  it('shows the locked answer after the server confirms', () => {
    renderQuestion({ answered: true, selected_option_id: 12 });

    expect(screen.getByText(/answer locked/i)).toBeInTheDocument();
    expect(screen.getByText(/B · Cover 3/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cover 2/ })).not.toBeInTheDocument();
  });

  it('shows an honest missed state when time ran out unanswered', () => {
    // Driven by the SERVER TIMESTAMPS, not by a flag: the window is shut
    // because the deadline has passed.
    renderQuestion({
      question_opened_at: '2026-08-12T12:59:30.000+00:00',
      question_closes_at: '2026-08-12T12:59:50.000+00:00',
      answering_open: false,
    });

    expect(screen.getByText(/time.s up/i)).toBeInTheDocument();
    expect(screen.getByText(/didn.t answer this one/i)).toBeInTheDocument();
    // No fabricated answer, and no way to sneak one in.
    expect(screen.queryByRole('button', { name: /Cover 2/ })).not.toBeInTheDocument();
  });

  it('renders the 3-2-1 while the question has not opened', () => {
    renderQuestion({
      question_opened_at: '2026-08-12T13:00:02.000+00:00',
      question_closes_at: '2026-08-12T13:00:22.000+00:00',
    });

    expect(screen.getByText(/get ready/i)).toBeInTheDocument();
    // And nothing answerable during the lead-in.
    expect(screen.queryByRole('button', { name: /Cover 2/ })).not.toBeInTheDocument();
  });
});

describe('images', () => {
  const withImage = {
    question: {
      ...round().question!,
      image: { image_url: '/uploads/x.png', annotations: [], canvas_width: 900 },
    },
  };

  it('shows a question image when there is one', () => {
    renderQuestion(withImage);
    expect(screen.getByAltText('Question image')).toBeInTheDocument();
  });

  it('keeps the answer controls present alongside an image', () => {
    renderQuestion(withImage);
    expect(screen.getByRole('button', { name: /Cover 2/ })).toBeInTheDocument();
  });

  it('survives a broken image without losing the question', () => {
    renderQuestion(withImage);

    const image = screen.getByAltText('Question image');
    image.dispatchEvent(new Event('error'));

    // The round carries on - a failed image must never take Competition down.
    expect(screen.getByText('Which coverage is this?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cover 2/ })).toBeInTheDocument();
  });
});

describe('the reveal', () => {
  function revealRound(result: Partial<NonNullable<competitionApi.PlayerRound['result']>>) {
    return round({
      status: 'QUESTION_REVEAL',
      answered: true,
      selected_option_id: 11,
      question: {
        ...round().question!,
        correct_option_id: 11,
        answer_explanation: 'Two deep safeties.',
        options: [
          { id: 11, option_text: 'Cover 2', position: 0, is_correct_answer: true },
          { id: 12, option_text: 'Cover 3', position: 1, is_correct_answer: false },
        ],
      },
      result: {
        answered: true,
        is_correct: true,
        points_earned: 109,
        total_points: 109,
        current_streak: 1,
        best_streak: 1,
        ...result,
      },
    });
  }

  it('states the verdict with a word, not colour alone', () => {
    render(<PlayerRevealScreen round={revealRound({})} />);

    expect(screen.getByText('Correct')).toBeInTheDocument();
    expect(screen.getByText('✓')).toBeInTheDocument();
  });

  it('distinguishes a wrong answer from no answer at all', () => {
    const { rerender } = render(
      <PlayerRevealScreen round={revealRound({ is_correct: false, points_earned: 0 })} />,
    );
    expect(screen.getByText('Incorrect')).toBeInTheDocument();

    rerender(
      <PlayerRevealScreen
        round={revealRound({ answered: false, is_correct: null, points_earned: 0 })}
      />,
    );
    // Telling somebody they got it wrong when they never got to answer is a
    // different and worse message.
    expect(screen.getByText('No answer')).toBeInTheDocument();
    expect(screen.queryByText('Incorrect')).not.toBeInTheDocument();
  });

  it('shows the correct answer, points and total', () => {
    render(<PlayerRevealScreen round={revealRound({})} />);

    expect(screen.getByText('Cover 2')).toBeInTheDocument();
    expect(screen.getByText('+109')).toBeInTheDocument();
    expect(screen.getByText('109')).toBeInTheDocument();
  });

  it('makes the explanation a real element, not fine print', () => {
    render(<PlayerRevealScreen round={revealRound({})} />);

    expect(screen.getByText('Two deep safeties.')).toBeInTheDocument();
    expect(screen.getByText('Why')).toBeInTheDocument();
  });

  it('shows a streak only from three in a row', () => {
    const { rerender } = render(
      <PlayerRevealScreen round={revealRound({ current_streak: 2 })} />,
    );
    expect(screen.queryByText(/in a row/i)).not.toBeInTheDocument();

    rerender(<PlayerRevealScreen round={revealRound({ current_streak: 3 })} />);
    expect(screen.getByText('3 in a row')).toBeInTheDocument();
  });
});
