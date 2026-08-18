/** A QUESTION'S PICTURE MUST BE THERE THE FIRST TIME A PLAYER ARRIVES.
 *
 * THE BUG THIS PINS, reported from a real Peira sent to players: the image on
 * Q18 did not appear on first arrival. Going forward to Q19 and back made it
 * appear. So the image existed, loaded and could render - it was simply
 * invisible until the player performed a navigation cycle nobody told them
 * about.
 *
 * ROOT CAUSE. Fabric restores the canvas element's inline style on dispose:
 * its constructor captures `el.style.cssText`, and `cleanupDOM` writes that
 * exact string back. AnnotationViewer gates visibility through React's inline
 * `style` (`display: none` until `isReady`), so a viewer REUSED for a second
 * image had `display: none` written back underneath React - and the reload
 * then called `setIsReady(true)` while isReady was already true. React bailed
 * out of the no-op update, never re-rendered, and never re-applied `display`.
 * The new image painted onto a permanently hidden canvas.
 *
 * WHY THIS IS A QuizStep TEST AND NOT A COMPONENT TEST. The viewer is only
 * reused because `QuestionInput` is rendered without a `key` in the
 * one-question-at-a-time flow, so React keeps one instance across questions. A
 * standalone AnnotationViewer test mounts fresh every time and never meets the
 * bug - and `QuestionInput.test.tsx` mocks the viewer out entirely, which is
 * why nothing caught this.
 *
 * WHY THESE EXACT SEQUENCES. The failure needs a question with an ANNOTATED
 * image arrived at FROM another question with an annotated image. A question
 * with no image unmounts the viewer, which is precisely why the player's
 * return trip looked like a cure.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuizStep } from './QuizStep';
import * as playApi from '../../api/play';
import type { DeliveredPlayerQuestion, Quiz } from '../../api/types';

// jsdom never loads image resources, so an <img>'s load event never fires.
// Same shim AnnotationCanvas.test.tsx uses, for the same reason.
beforeAll(() => {
  const proto = window.HTMLImageElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'src')!;
  Object.defineProperty(proto, 'src', {
    get() {
      return desc.get!.call(this);
    },
    set(value: string) {
      desc.set!.call(this, value);
      if (value) setTimeout(() => this.dispatchEvent(new Event('load')), 0);
    },
  });
});

// The REAL AnnotationViewer and the REAL Fabric StaticCanvas run here - they
// are what the bug lives in, so stubbing either would test nothing. Only the
// image decode is faked, which jsdom cannot do. `loadedUrls` records what the
// viewer actually asked for, which is how the delivered-vs-live assertion
// below is made.
const loadedUrls: string[] = [];
vi.mock('../../components/annotation/imageLoading', () => ({
  loadPrescaledImage: vi.fn(async (url: string) => {
    loadedUrls.push(url);
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 300;
    return { canvas, width: 400, height: 300, naturalWidth: 400 };
  }),
}));

type Shape = 'annotated' | 'plain' | 'none';

function question(id: number, image: Shape) {
  return {
    id,
    quiz_id: 1,
    question_text: `Question ${id}?`,
    question_type: 'multiple_choice' as const,
    position: id - 1,
    image:
      image === 'none'
        ? null
        : {
            id: id * 100,
            question_id: id,
            image_url: `/live-${id}.png`,
            canvas_width: 800,
            annotations:
              image === 'annotated' ? [{ type: 'Circle', left: 10, top: 10, radius: 5 }] : [],
          },
    options: [
      { id: id * 10, question_id: id, option_text: 'A', position: 0 },
      { id: id * 10 + 1, question_id: id, option_text: 'B', position: 1 },
    ],
  };
}

function quizOf(questions: ReturnType<typeof question>[]): Quiz {
  return {
    id: 1,
    organization_id: 1,
    coach_id: 1,
    created_by_username: 'coach1',
    title: 'Week 1 Prep',
    description: null,
    one_question_at_a_time: true,
    require_all_answers: false,
    folder_id: null,
    question_count: questions.length,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    questions: questions as unknown as Quiz['questions'],
  };
}

function play(questions: ReturnType<typeof question>[], delivered?: DeliveredPlayerQuestion[]) {
  vi.spyOn(playApi, 'saveAnswer').mockResolvedValue(undefined);
  render(
    <QuizStep
      quiz={quizOf(questions)}
      accessCodeId={42}
      playerName="Jordan Smith"
      playerId={1}
      initialAnswers={[]}
      deliveredQuestions={delivered}
      onSubmitted={vi.fn()}
    />,
  );
}

type User = ReturnType<typeof userEvent.setup>;
const next = (user: User) => user.click(screen.getByRole('button', { name: 'Next' }));
const back = (user: User) => user.click(screen.getByRole('button', { name: 'Back' }));

/** An annotated picture renders as a <canvas role="img">. "Shown" means
 *  present AND NOT HIDDEN - asserting presence alone is exactly what let this
 *  ship, because the element was in the DOM the entire time. */
async function expectPictureShown() {
  const canvas = await screen.findByRole('img', { name: /film still/i });
  await waitFor(() => expect((canvas as HTMLCanvasElement).style.display).toBe('block'));
}

beforeEach(() => {
  loadedUrls.length = 0;
});

/** `resolveMediaUrl` prefixes the API host, so the viewer is handed an
 *  absolute URL. Matching on the path is what keeps these assertions about
 *  WHICH PICTURE was requested rather than about host configuration. */
const loaded = (path: string) => loadedUrls.some((url) => url.endsWith(path));

describe('the picture is there on the first visit', () => {
  it('shows it when the previous question also had an annotated picture', async () => {
    const user = userEvent.setup();
    play([question(17, 'annotated'), question(18, 'annotated')]);

    // PRECONDITION: Q17's picture is genuinely up, so the viewer really is
    // being reused rather than mounted fresh on Q18.
    await expectPictureShown();
    expect(screen.getByText('Question 17?')).toBeInTheDocument();

    await next(user);

    // On Q18. First arrival. No navigation cycle performed.
    expect(screen.getByText('Question 18?')).toBeInTheDocument();
    await expectPictureShown();
    expect(loaded('/live-18.png')).toBe(true);
  });

  it('shows it when the previous question had no picture at all', async () => {
    const user = userEvent.setup();
    play([question(17, 'none'), question(18, 'annotated')]);
    expect(screen.queryByRole('img', { name: /film still/i })).toBeNull();

    await next(user);

    await expectPictureShown();
  });

  it('shows a plain unannotated picture immediately', async () => {
    const user = userEvent.setup();
    play([question(17, 'annotated'), question(18, 'plain')]);
    await expectPictureShown();

    await next(user);

    // No annotations means a plain <img>, a path this bug never touched.
    // Pinned so the fix cannot quietly move it onto the canvas path.
    const img = await screen.findByAltText('Film still');
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toContain('/live-18.png');
  });
});

describe('and it stays there', () => {
  it('survives next and back across annotated questions', async () => {
    const user = userEvent.setup();
    play([question(17, 'annotated'), question(18, 'annotated'), question(19, 'annotated')]);
    await expectPictureShown();

    await next(user);
    await expectPictureShown();
    await next(user);
    await expectPictureShown();
    await back(user);

    expect(screen.getByText('Question 18?')).toBeInTheDocument();
    await expectPictureShown();
  });

  it('survives the exact reported sequence, where the next question has none', async () => {
    // The sequence that made the bug look self-healing: leaving to a question
    // with no image unmounted the viewer, so the return trip mounted a fresh
    // one and worked. BOTH visits must now be correct, not just the second.
    const user = userEvent.setup();
    play([question(17, 'annotated'), question(18, 'annotated'), question(19, 'none')]);
    await expectPictureShown();

    await next(user);
    await expectPictureShown();

    await next(user);
    expect(screen.queryByRole('img', { name: /film still/i })).toBeNull();

    await back(user);
    expect(screen.getByText('Question 18?')).toBeInTheDocument();
    await expectPictureShown();
  });
});

describe('the attempt version invariant is untouched', () => {
  it('renders the DELIVERED picture on first visit, never the live one', async () => {
    // A coach replaced the picture after this attempt started. The player must
    // still be shown the one they were given - and must be shown it
    // immediately, which is the whole point of this file.
    const user = userEvent.setup();
    const annotations = [{ type: 'Circle', left: 10, top: 10, radius: 5 }];
    const delivered: DeliveredPlayerQuestion[] = [17, 18].map((id) => ({
      id,
      question_text: `Question ${id}?`,
      question_type: 'multiple_choice',
      options: [{ id: id * 10, option_text: 'A' }],
      image: {
        id: id * 100,
        image_url: `/delivered-${id}.png`,
        canvas_width: 800,
        annotations,
      },
    }));
    play([question(17, 'annotated'), question(18, 'annotated')], delivered);
    await expectPictureShown();

    await next(user);
    await expectPictureShown();

    expect(loaded('/delivered-18.png')).toBe(true);
    expect(loaded('/live-18.png')).toBe(false);
  });
});
