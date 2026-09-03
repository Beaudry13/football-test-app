import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QuestionInput, type PlayerAnswer } from './QuestionInput';
import type { Question } from '../../api/types';

/** A PLAYER MUST NEVER BE TRAPPED INSIDE A PHOTOGRAPH.
 *
 * REPORTED FROM A REAL PHONE: a player tapped a question image, it enlarged,
 * and there was no way back out - they had to reload the browser tab, losing
 * their place in the quiz.
 *
 * THE CAUSE WAS STACKING ORDER, not a missing button. `Modal` renders its close
 * button BEFORE `{children}`, and only the backdrop carried a z-index. The
 * lightbox's children are a pinch-zoom surface with `touch-action: none` that
 * captures pointers and stops click propagation - so on a phone, where a large
 * image fills the panel, the button sat UNDERNEATH the image and every tap on
 * it went to the image instead. Escape still worked, which is exactly why this
 * only ever trapped mobile players.
 *
 * These drive the REAL player component an activated quiz renders, not
 * Preview-as-player, because the reported failure was on the real route.
 */

vi.mock('../../api/play', () => ({
  saveAnswer: vi.fn(),
  startAttempt: vi.fn(),
}));

const imageQuestion = (): Question =>
  ({
    id: 42,
    quiz_id: 7,
    question_text: 'Which coverage is shown?',
    question_type: 'multiple_choice',
    position: 0,
    options: [
      { id: 1, option_text: 'Cover 3', is_correct_answer: false },
      { id: 2, option_text: 'Cover 2', is_correct_answer: false },
    ],
    image: { id: 9, question_id: 42, image_url: '/uploads/play.jpg', annotations: [] },
    needs_image: false,
    clip: null,
  }) as unknown as Question;

function renderQuestion(answer?: PlayerAnswer) {
  const onChange = vi.fn();
  const view = render(
    <QuestionInput
      question={imageQuestion()}
      index={0}
      answer={answer}
      onChange={onChange}
    />,
  );
  return { ...view, onChange };
}

function openViewer() {
  fireEvent.click(screen.getByAltText('Film still'));
}

describe('the enlarged image always has a way out', () => {
  it('opens when the player taps the image', () => {
    renderQuestion();
    openViewer();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('exposes a close control', () => {
    renderQuestion();
    openViewer();
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });

  it('closing returns the player to the question', () => {
    renderQuestion();
    openViewer();

    fireEvent.click(screen.getByRole('button', { name: /close/i }));

    expect(screen.queryByRole('dialog')).toBeNull();
    // The question itself is still there, not reloaded.
    expect(screen.getByText(/which coverage is shown/i)).toBeInTheDocument();
  });

  it('Escape closes it on desktop', () => {
    renderQuestion();
    openViewer();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an answer already chosen survives opening and closing the image', () => {
    // A player who has picked an option and then looks closer at the film must
    // not come back to an empty question.
    const answer = { selected_option_id: 2 } as unknown as PlayerAnswer;
    renderQuestion(answer);

    openViewer();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));

    const chosen = screen.getByRole('radio', { name: /cover 2/i });
    expect(chosen).toBeChecked();
  });

  it('the close control is stacked ABOVE the panel content', () => {
    // THE REGRESSION, expressed as the rule that fixes it. jsdom applies no
    // CSS, so the stylesheet is read directly - the button is rendered before
    // `{children}`, so without its own stacking order any positioned content
    // paints over it, which is precisely what a full-bleed image did.
    // Read from the project root: vitest runs with the frontend as its cwd.
    // Comments are stripped BEFORE the rule is located: this file explains its
    // reasoning at length, and a comment mentioning `{children}` contains a
    // closing brace that would end the slice early.
    const css = readFileSync('src/components/ui/Modal.module.css', 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const at = css.indexOf('.closeButton {');
    expect(at).toBeGreaterThan(-1);
    const body = css.slice(at, css.indexOf('}', at));
    expect(body).toMatch(/z-index:\s*[1-9]/);
  });
});
