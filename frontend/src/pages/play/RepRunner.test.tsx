import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/play', () => ({
  saveAnswer: vi.fn(),
  checkAnswer: vi.fn(),
  submitQuiz: vi.fn(),
}));
vi.mock('../../api/reps', () => ({ getRepProgress: vi.fn() }));
// The moving picture's own business is tested in motion-lab; here it is a
// stand-in the test can bring to the snap.
vi.mock('../../motion-lab/PresnapPicture', () => ({
  default: ({ onDone, children }: { onDone?: () => void; children?: unknown }) => (
    <div>
      <button type="button" onClick={onDone}>
        bring it to the snap
      </button>
      {children as never}
    </div>
  ),
}));
import * as playApi from '../../api/play';
import * as repsApi from '../../api/reps';
import type { Question, Quiz } from '../../api/types';
import { RepRunner } from './RepRunner';

/**
 * SITUATIONAL REP, the player's side: one decision per screen; tapping an
 * answer IS answering (saved and judged at once); the verdict and the coach's
 * reason; at the end the score, the concepts missed and Review missed.
 */

const decision = (id: number, text: string, options: string[], concept: string, role = 'Boundary safety'): Question =>
  ({
    id,
    quiz_id: 1,
    question_text: text,
    question_type: 'multiple_choice',
    position: id,
    subject_role: role,
    concept: { id: id * 10, name: concept, is_archived: false },
    image: { id, question_id: id, image_url: '/uploads/play.png', annotations: null, canvas_width: null, updated_at: '' },
    options: options.map((option_text, i) => ({ id: id * 100 + i, question_id: id, option_text, position: i })),
  }) as unknown as Question;

const QUIZ = {
  id: 1,
  title: 'Trips Jet - Boundary safety',
  kind: 'REP',
  questions: [
    decision(1, '#3 motions across. What is your check?', ['Rotate down', 'Stay boundary'], 'Motion adjustment'),
    decision(2, 'Who has #3 on the seam?', ['Me', 'The corner'], 'Seam'),
  ],
} as unknown as Quiz;

function run(overrides: Partial<Parameters<typeof RepRunner>[0]> = {}) {
  const onRunAgain = vi.fn();
  render(
    <RepRunner
      quiz={QUIZ}
      accessCodeId={7}
      playerName="Marcus Hill"
      playerId={21}
      initialAnswers={[]}
      initialFeedback={[]}
      onRunAgain={onRunAgain}
      {...overrides}
    />,
  );
  return onRunAgain;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(repsApi.getRepProgress).mockResolvedValue({ previous: null, original: null });
  vi.mocked(playApi.saveAnswer).mockResolvedValue(undefined as never);
  vi.mocked(playApi.submitQuiz).mockResolvedValue({} as never);
  vi.mocked(playApi.checkAnswer).mockImplementation(async ({ question_id }) => ({
    question_id,
    auto_gradable: true,
    // Decision 1 missed, decision 2 right.
    is_correct: question_id === 2,
    answer_explanation: question_id === 1 ? 'He is the new #3 - rotate down to him.' : null,
  }));
});

describe('A Situational Rep, for the player', () => {
  it('shows who he is, the picture and the question - and one tap answers it', async () => {
    run();
    expect(screen.getByText('Boundary safety')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'The play' })).toHaveAttribute('src', expect.stringContaining('/uploads/play.png'));
    expect(screen.getByRole('heading', { name: '#3 motions across. What is your check?' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /check/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Stay boundary' }));
    expect(await screen.findByText(/Not quite/)).toBeInTheDocument();
    expect(screen.getByText(/He is the new #3/)).toBeInTheDocument();
    const [saved] = vi.mocked(playApi.saveAnswer).mock.calls[0];
    expect(saved).toMatchObject({ access_code_id: 7, player_id: 21, question_id: 1, selected_option_id: 101 });
    expect(typeof saved.time_to_answer_ms).toBe('number');
    expect(playApi.checkAnswer).toHaveBeenCalledWith(expect.objectContaining({ question_id: 1 }));
    // Locked once judged.
    expect(screen.getByRole('button', { name: 'Rotate down' })).toBeDisabled();
  });

  it('ends with the score, the concept missed, and a review of exactly what he missed', async () => {
    const onRunAgain = run();
    fireEvent.click(screen.getByRole('button', { name: 'Stay boundary' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Me' }));
    expect(await screen.findByText(/Correct/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));

    expect(await screen.findByText('1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Motion adjustment')).toBeInTheDocument();
    expect(screen.queryByText('Seam')).toBeNull();
    expect(playApi.submitQuiz).toHaveBeenCalledWith(
      expect.objectContaining({
        answers: [
          expect.objectContaining({ question_id: 1, selected_option_id: 101 }),
          expect.objectContaining({ question_id: 2, selected_option_id: 200 }),
        ],
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Review missed' }));
    expect(screen.getByText('Missed 1 of 1')).toBeInTheDocument();
    expect(screen.getByText('You chose: Stay boundary')).toBeInTheDocument();
    expect(screen.getByText(/He is the new #3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run it again' }));
    expect(onRunAgain).toHaveBeenCalled();
  });

  it('a decision about men is answered by tapping the man in the picture', async () => {
    const tap = {
      ...decision(3, 'Who gets the ball?', ['X', 'Z'], 'Ball'),
      tap_targets: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }],
    } as unknown as Question;
    run({ quiz: { ...QUIZ, questions: [tap] } as unknown as Quiz });
    expect(screen.getByText('Tap the man in the picture')).toBeInTheDocument();
    const z = screen.getByRole('button', { name: 'Tap Z' });
    expect(z).toHaveStyle({ left: '90%', top: '50%' });
    fireEvent.click(z);
    await waitFor(() => expect(playApi.checkAnswer).toHaveBeenCalled());
    expect(vi.mocked(playApi.saveAnswer).mock.calls[0][0]).toMatchObject({ question_id: 3, selected_option_id: 301 });
    expect(screen.getByRole('button', { name: 'Tap X' })).toBeDisabled();
  });

  it('Review missed shows his tap on the picture he tapped - and not the right one (the coach says why)', async () => {
    const tap = {
      ...decision(1, 'Who gets the ball?', ['X', 'Z'], 'Ball'),
      tap_targets: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }],
    } as unknown as Question;
    run({ quiz: { ...QUIZ, questions: [tap] } as unknown as Quiz });
    fireEvent.click(screen.getByRole('button', { name: 'Tap Z' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review missed' }));
    const his = screen.getByRole('button', { name: 'Tap Z' });
    expect(his).toBeDisabled();
    expect(his.className).toMatch(/wrong/);
    expect(screen.getByRole('button', { name: 'Tap X' }).className).not.toMatch(/right/);
    expect(screen.queryByText('Tap the man in the picture')).toBeNull();
    expect(screen.getByText(/He is the new #3/)).toBeInTheDocument();
  });

  it('a Rep teaches: after a miss it names the right answer, on the buttons and in words', async () => {
    vi.mocked(playApi.checkAnswer).mockImplementation(async ({ question_id }) => ({
      question_id,
      auto_gradable: true,
      is_correct: false,
      answer_explanation: 'He is the new #3 - rotate down to him.',
      correct_option_ids: [100],
    }));
    run();
    fireEvent.click(screen.getByRole('button', { name: 'Stay boundary' }));
    expect(await screen.findByText(/Right answer:/)).toHaveTextContent('Right answer: Rotate down');
    const right = screen.getByRole('button', { name: /Rotate down/ });
    expect(right.className).toMatch(/right/);
    expect(right).toHaveTextContent('✓ Rotate down');
    expect(screen.getByRole('button', { name: 'Stay boundary' }).className).toMatch(/wrong/);
  });

  it('Review missed on a Rep: his tap and the right spot on the picture, the point - then Run it again', async () => {
    vi.mocked(playApi.checkAnswer).mockImplementation(async ({ question_id }) => ({
      question_id,
      auto_gradable: true,
      is_correct: false,
      answer_explanation: 'X runs the jet - the ball goes to him.',
      correct_option_ids: [100],
    }));
    const tap = {
      ...decision(1, 'Who gets the ball?', ['X', 'Z'], 'Ball'),
      tap_targets: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }],
    } as unknown as Question;
    const onRunAgain = run({ quiz: { ...QUIZ, questions: [tap] } as unknown as Quiz });
    fireEvent.click(screen.getByRole('button', { name: 'Tap Z' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Review missed' }));
    expect(screen.getByRole('button', { name: 'Tap Z' }).className).toMatch(/wrong/);
    expect(screen.getByRole('button', { name: 'Tap X' }).className).toMatch(/right/);
    expect(screen.getByText('You chose: Z')).toBeInTheDocument();
    expect(screen.getByText(/Right answer:/)).toHaveTextContent('Right answer: X');
    expect(screen.getByText(/X runs the jet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run it again' }));
    expect(onRunAgain).toHaveBeenCalled();
  });

  it('a decision about a place is answered by tapping the labelled spot on the field', async () => {
    const tap = {
      ...decision(3, 'What is your gap?', ['A gap', 'B gap'], 'Run fits'),
      tap_targets: [{ x: 0.48, y: 0.5, zone: true }, { x: 0.44, y: 0.5, zone: true }],
    } as unknown as Question;
    run({ quiz: { ...QUIZ, questions: [tap] } as unknown as Quiz });
    expect(screen.getByText('Tap the spot on the field')).toBeInTheDocument();
    const b = screen.getByRole('button', { name: 'Tap B gap' });
    expect(b).toHaveTextContent('B gap');
    fireEvent.click(b);
    await waitFor(() => expect(playApi.checkAnswer).toHaveBeenCalled());
    expect(vi.mocked(playApi.saveAnswer).mock.calls[0][0]).toMatchObject({ question_id: 3, selected_option_id: 301 });
  });

  it('the finish says what he has and what to work on, and how he did against last time', async () => {
    vi.mocked(repsApi.getRepProgress).mockResolvedValue({
      previous: { correct: 0, answered: 2, missed_concepts: ['Motion adjustment', 'Seam'], mastered_concepts: [] },
      original: { title: 'Trips Jet', correct: 0, answered: 2, missed_concepts: ['Seam'], mastered_concepts: [] },
    });
    run();
    fireEvent.click(screen.getByRole('button', { name: 'Stay boundary' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Me' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Finish' }));
    expect(await screen.findByText('1 of 2')).toBeInTheDocument();
    expect(within(screen.getByLabelText("You've got")).getByText('✓ Seam')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Work on')).getByText('Motion adjustment')).toBeInTheDocument();
    expect(await screen.findByText('Last run 0 of 2 → now 1 of 2')).toBeInTheDocument();
    expect(screen.getByText(/You missed Seam the first time\. Now you.ve got it\./)).toBeInTheDocument();
    expect(repsApi.getRepProgress).toHaveBeenCalledWith({ access_code_id: 7, player_name: 'Marcus Hill', player_id: 21 });
  });

  it('plays the motion first: the answers wait for the snap', async () => {
    const moving = {
      ...decision(4, '#3 motions across. What is your check?', ['Rotate down', 'Stay boundary'], 'Motion adjustment'),
      presnap: { v: 1, situation: {}, highlight: null, players: [] },
    } as unknown as Question;
    run({ quiz: { ...QUIZ, questions: [moving] } as unknown as Quiz });
    expect(await screen.findByText('Watch the motion…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rotate down' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'bring it to the snap' }));
    expect(screen.queryByText('Watch the motion…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate down' }));
    await waitFor(() => expect(playApi.saveAnswer).toHaveBeenCalled());
  });

  it('picks up where he left off', () => {
    run({
      initialAnswers: [{ question_id: 1, selected_option_id: 101, selected_option_ids: [101], answer_text: null, checked: true }],
      initialFeedback: [{ question_id: 1, auto_gradable: true, is_correct: false, answer_explanation: null }],
    });
    expect(screen.getByRole('heading', { name: 'Who has #3 on the seam?' })).toBeInTheDocument();
  });

  it('lets him tap again when the answer could not be saved', async () => {
    vi.mocked(playApi.saveAnswer).mockRejectedValueOnce(new Error('No signal'));
    run();
    fireEvent.click(screen.getByRole('button', { name: 'Stay boundary' }));
    expect(await screen.findByText('No signal')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stay boundary' })).toBeEnabled());
    expect(screen.queryByText(/Not quite/)).toBeNull();
  });
});
