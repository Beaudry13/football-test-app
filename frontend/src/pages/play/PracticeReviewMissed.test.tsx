import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PracticeFeedback, Question } from '../../api/types';
import { PracticeCompleteStep } from './PracticeCompleteStep';

/**
 * A NORMAL QUIZ'S PRACTICE ENDS LIKE A REP: Review missed - each missed
 * question again, the football picture, his tap on it, and the coach's reason.
 * The right answer is the coach's to say (no automatic reveal).
 */

const image = { id: 1, question_id: 1, image_url: '/uploads/play.png', annotations: [], canvas_width: null, updated_at: '' };
const q = (id: number, text: string, extra: Partial<Question> = {}): Question =>
  ({
    id,
    quiz_id: 1,
    question_text: text,
    question_type: 'multiple_choice',
    position: id,
    image,
    options: [
      { id: id * 10, question_id: id, option_text: 'X', position: 0 },
      { id: id * 10 + 1, question_id: id, option_text: 'Z', position: 1 },
    ],
    ...extra,
  }) as unknown as Question;

const questions = [
  q(1, 'Who gets the ball?', { tap_targets: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] }),
  q(2, 'Who blocks the end?'),
];
const feedback: PracticeFeedback[] = [
  { question_id: 1, auto_gradable: true, is_correct: false, answer_explanation: 'The jet motion takes the ball.' },
  { question_id: 2, auto_gradable: true, is_correct: true, answer_explanation: null },
] as PracticeFeedback[];

describe('practice ends with Review missed, as a Rep does', () => {
  it('each missed question again - the picture, his tap on it, the coach’s reason', () => {
    render(
      <PracticeCompleteStep feedback={feedback} review={{ questions, chosen: { 1: [11], 2: [20] } }} onTryAgain={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review missed' }));
    expect(screen.getByText('Missed 1 of 1')).toBeInTheDocument();
    expect(screen.getByText('You chose: Z')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tap Z' }).className).toMatch(/wrong/);
    expect(screen.getByRole('button', { name: 'Tap X' }).className).not.toMatch(/right/);
    expect(screen.getByText(/The jet motion takes the ball/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('heading', { name: 'Practice complete' })).toBeInTheDocument();
  });

  it('nothing missed, nothing to review', () => {
    render(<PracticeCompleteStep feedback={[feedback[1]]} review={{ questions, chosen: {} }} onTryAgain={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Review missed' })).toBeNull();
  });
});

/** TRY THE MISSES AGAIN: after seeing what he missed, the one obvious next
 *  thing is trying just those - the whole quiz again stays, quietly. */
describe('try the misses again', () => {
  it('review first, then just the misses - the whole quiz over is still there, quietly', () => {
    const onRetry = vi.fn();
    const onWhole = vi.fn();
    render(
      <PracticeCompleteStep
        feedback={feedback}
        review={{ questions, chosen: { 1: [11], 2: [20] } }}
        onTryAgain={onWhole}
        onRetryMisses={onRetry}
      />,
    );
    expect(screen.getByRole('button', { name: 'Review missed' }).className).toMatch(/btn-primary/);
    expect(screen.getByRole('button', { name: 'Try the misses again' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start the whole quiz over' }));
    expect(onWhole).toHaveBeenCalled();
    // And at the end of the review it is the one thing to do next.
    fireEvent.click(screen.getByRole('button', { name: 'Review missed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try the misses again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('nothing missed: no retry offered, just Try again', () => {
    render(
      <PracticeCompleteStep feedback={[feedback[1]]} review={{ questions, chosen: {} }} onTryAgain={vi.fn()} onRetryMisses={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Try the misses again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' }).className).toMatch(/btn-primary/);
  });

  it('a run that was his misses again says so', () => {
    render(<PracticeCompleteStep feedback={[feedback[1]]} review={{ questions, chosen: {} }} onTryAgain={vi.fn()} isRetry />);
    expect(screen.getByRole('heading', { name: 'Your misses, again' })).toBeInTheDocument();
  });
});
