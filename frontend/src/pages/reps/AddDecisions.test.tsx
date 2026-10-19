import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/quizzes', () => ({ listQuizzes: vi.fn(), getQuiz: vi.fn() }));
vi.mock('../../api/reps', () => ({ addDecisions: vi.fn() }));
vi.mock('../../api/motionLab', () => ({ listMotionPlays: vi.fn() }));
import * as quizzesApi from '../../api/quizzes';
import * as repsApi from '../../api/reps';
import * as motionApi from '../../api/motionLab';
import * as authModule from '../../auth/AuthContext';
import { AddDecisions } from './AddDecisions';

/** BUILD A REP FROM WHAT YOU HAVE: tick questions from any quiz, or open a play aimed at this Rep. */

const q = (id: number, text: string, type = 'multiple_choice', extra = {}) => ({
  id,
  question_text: text,
  question_type: type,
  options: [],
  is_retired: false,
  allows_multiple_answers: false,
  ...extra,
});

function open(owner = false) {
  vi.spyOn(authModule, 'useAuth').mockReturnValue({ coach: { id: 1, is_platform_owner: owner } } as never);
  const onAdded = vi.fn();
  render(
    <MemoryRouter>
      <AddDecisions repId={5} onAdded={onAdded} />
    </MemoryRouter>,
  );
  return onAdded;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(quizzesApi.listQuizzes).mockReset().mockResolvedValue([
    { id: 3, title: 'Week 3 install', kind: 'QUIZ', question_count: 3, updated_at: '2026-10-14' },
    { id: 5, title: 'This rep', kind: 'REP', question_count: 2, updated_at: '2026-10-15' },
  ] as never);
  vi.mocked(quizzesApi.getQuiz).mockReset().mockResolvedValue({
    id: 3,
    title: 'Week 3 install',
    questions: [
      q(31, 'Identify the coverage.'),
      q(32, 'Describe your fit.', 'written'),
      q(33, 'Is the safety in the box?', 'true_false'),
    ],
  } as never);
  vi.mocked(repsApi.addDecisions).mockReset().mockResolvedValue({ id: 5, added: 2 } as never);
  vi.mocked(motionApi.listMotionPlays).mockReset().mockResolvedValue([
    { id: 14, name: 'Spread Motion Pass', updated_at: '2026-10-10' },
  ] as never);
});

describe('Add decisions to a rep', () => {
  it('ticks questions from a quiz and adds them - only the ones a Rep can judge on the spot', async () => {
    const onAdded = open();
    const quizzes = within(await screen.findByRole('list', { name: 'Quizzes' }));
    expect(quizzes.queryByText('This rep')).toBeNull();
    fireEvent.click(quizzes.getByRole('button', { name: /Week 3 install/ }));
    const questions = within(await screen.findByRole('list', { name: 'Questions in Week 3 install' }));
    expect(questions.queryByText('Describe your fit.')).toBeNull();
    fireEvent.click(questions.getByRole('checkbox', { name: 'Identify the coverage.' }));
    fireEvent.click(questions.getByRole('checkbox', { name: 'Is the safety in the box?' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 to this rep' }));
    await waitFor(() => expect(repsApi.addDecisions).toHaveBeenCalledWith(5, 3, [31, 33]));
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
  });

  it('a coach with Motion Lab opens a play with Make rep aimed at this rep', async () => {
    open(true);
    fireEvent.click(await screen.findByRole('tab', { name: 'From a Motion Lab play' }));
    const plays = within(await screen.findByRole('list', { name: 'Motion Lab plays' }));
    expect(plays.getByRole('link', { name: /Spread Motion Pass/ })).toHaveAttribute('href', '/motion-lab/plays/14?rep=5');
  });

  it('a coach without Motion Lab is not offered plays', async () => {
    open(false);
    await screen.findByRole('list', { name: 'Quizzes' });
    expect(screen.queryByRole('tab', { name: 'From a Motion Lab play' })).toBeNull();
  });
});
