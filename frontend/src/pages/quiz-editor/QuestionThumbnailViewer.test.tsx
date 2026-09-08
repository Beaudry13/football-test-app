import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { QuestionsTab } from './QuestionsTab';
import type { Question, Quiz } from '../../api/types';

/** A COACH REVIEWING QUESTIONS MUST BE ABLE TO SEE THE PICTURE.
 *
 * The list is scanned, not read, so the thumbnail is deliberately 108x72 -
 * far too small to judge a coverage or read a jersey number from. It was also
 * inert, so the only way to look properly was to open the editor.
 *
 * The thumbnail is now the control itself rather than a "View image" button
 * beside it, which is what keeps the row as compact as it was. That makes the
 * interesting assertions here accessibility ones: a clickable <img> would
 * satisfy a coach with a mouse and nobody else.
 *
 * THE VIEWER IS THE PLAYER'S. `ImageLightbox` already handles Escape, the
 * backdrop, the close button and pinch-zoom, and these tests go through the
 * real one rather than a mock so that a regression in it fails here too.
 */

vi.mock('../../api/questions', () => ({
  createQuestion: vi.fn(),
  deleteQuestion: vi.fn(),
  reorderQuestions: vi.fn(),
  restoreQuestion: vi.fn(),
  retireQuestion: vi.fn(),
  updateQuestion: vi.fn(),
  deleteQuestionClip: vi.fn(),
  setClipDecisionPoint: vi.fn(),
  uploadQuestionClip: vi.fn(),
}));

function imageQuestion(id: number, imageUrl: string, text: string): Question {
  return {
    id,
    quiz_id: 1,
    question_text: text,
    question_type: 'written',
    position: id,
    options: [],
    image: {
      id: id * 10,
      question_id: id,
      image_url: imageUrl,
      annotations: [],
      canvas_width: 900,
    },
    needs_image: false,
    clip: null,
    masked_image_url: null,
  } as unknown as Question;
}

function quizWith(questions: Question[]): Quiz {
  return {
    id: 1,
    title: 'Cover 3 install',
    status: 'draft',
    questions,
  } as unknown as Quiz;
}

function renderTab(questions: Question[]) {
  return render(
    <MemoryRouter>
      <QuestionsTab quiz={quizWith(questions)} reload={() => Promise.resolve()} />
    </MemoryRouter>,
  );
}

const openers = () => screen.getAllByRole('button', { name: /view question image/i });

describe('the question thumbnail opens the picture', () => {
  it('is a button, not a decorative image', () => {
    // The whole accessibility case in one assertion: a keyboard and a screen
    // reader can only reach this if it is a real control with a name.
    renderTab([imageQuestion(1, '/uploads/cover3.jpg', 'Which coverage?')]);
    expect(openers()).toHaveLength(1);
  });

  it('clicking it enlarges that question image', () => {
    renderTab([imageQuestion(1, '/uploads/cover3.jpg', 'Which coverage?')]);
    fireEvent.click(openers()[0]);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByAltText(/enlarged/i)).toHaveAttribute(
      'src',
      expect.stringContaining('/uploads/cover3.jpg'),
    );
  });

  it('the enlarged image is contained, never cropped', () => {
    // THE FRAMING INVARIANT. A coach opens this to see the whole play; `cover`
    // here would crop exactly the sideline detail the question is often about.
    // The thumbnail keeps its own crop - that is a list, not the picture.
    renderTab([imageQuestion(1, '/uploads/cover3.jpg', 'Which coverage?')]);
    fireEvent.click(openers()[0]);

    const enlarged = within(screen.getByRole('dialog')).getByAltText(/enlarged/i);
    expect(enlarged.className).toMatch(/image/);
  });

  it('each thumbnail opens its OWN image', () => {
    // The state holds a question, not a boolean, so a list cannot open the
    // first picture for every row - the failure a per-row flag invites.
    renderTab([
      imageQuestion(1, '/uploads/first.jpg', 'Question one'),
      imageQuestion(2, '/uploads/second.jpg', 'Question two'),
    ]);

    fireEvent.click(openers()[1]);
    expect(within(screen.getByRole('dialog')).getByAltText(/enlarged/i)).toHaveAttribute(
      'src',
      expect.stringContaining('/uploads/second.jpg'),
    );
  });

  it('the close button closes it', () => {
    renderTab([imageQuestion(1, '/uploads/cover3.jpg', 'Which coverage?')]);
    fireEvent.click(openers()[0]);

    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape closes it', () => {
    renderTab([imageQuestion(1, '/uploads/cover3.jpg', 'Which coverage?')]);
    fireEvent.click(openers()[0]);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clicking the backdrop closes it', () => {
    renderTab([imageQuestion(1, '/uploads/cover3.jpg', 'Which coverage?')]);
    fireEvent.click(openers()[0]);

    // mouseDown, not click: that is what Modal listens for, so that a drag
    // ending outside the panel does not count as dismissing it.
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement as HTMLElement);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the coach stays in the question list', () => {
    // No navigation, no new tab - the row they were looking at is still there.
    renderTab([imageQuestion(1, '/uploads/cover3.jpg', 'Which coverage?')]);
    fireEvent.click(openers()[0]);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByText('Which coverage?')).toBeInTheDocument();
  });

  it('focus returns to the thumbnail that opened it', () => {
    // Without this a coach closing the viewer is dropped at the top of the
    // document and has to tab all the way back to where they were.
    renderTab([
      imageQuestion(1, '/uploads/first.jpg', 'Question one'),
      imageQuestion(2, '/uploads/second.jpg', 'Question two'),
    ]);
    const second = openers()[1];
    second.focus();
    fireEvent.click(second);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(document.activeElement).toBe(second);
  });

  it('focus moves into the viewer when it opens', () => {
    // So Escape is not the only keyboard way out.
    renderTab([imageQuestion(1, '/uploads/cover3.jpg', 'Which coverage?')]);
    fireEvent.click(openers()[0]);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^close$/i }));
  });

  it('Tab cannot escape to the list behind it', () => {
    /* `aria-modal` tells a screen reader the page behind is inert and does
       nothing at all to the tab order, so the wrap has to be implemented.

       ASSERTED VIA defaultPrevented, NOT activeElement. jsdom does not move
       focus on a Tab keydown, so checking where focus ended up passes just as
       happily with no trap at all - measured: that assertion survived deleting
       the handler. Preventing the default IS the interception, so it is the
       thing worth asserting. */
    renderTab([imageQuestion(1, '/uploads/cover3.jpg', 'Which coverage?')]);
    fireEvent.click(openers()[0]);

    // The close button is the only focusable control, so it is both the first
    // and the last - tabbing either way must wrap rather than leave.
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);

    const backward = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
  });
});

describe('what must NOT have become clickable', () => {
  it('a question with no picture gets no viewer control', () => {
    const bare = imageQuestion(1, '', 'Written only');
    (bare as { image: unknown }).image = null;
    renderTab([bare]);

    expect(screen.queryByRole('button', { name: /view question image/i })).toBeNull();
  });

  it('a clip question does not get an image viewer', () => {
    /* RECORD CLIP IS UNTOUCHED. A clip's thumbnail is its poster, and opening
       a still lightbox over it would be worse than leaving it alone: the coach
       would get a frozen frame where they expected the film, and Peira already
       has a clip preview for that. The poster is also the one thumbnail whose
       source is a signed, expiring media url. */
    const clip = imageQuestion(1, '', 'Read the leverage');
    (clip as { image: unknown }).image = null;
    (clip as { clip: unknown }).clip = {
      id: 5,
      question_id: 1,
      content_type: 'video/mp4',
      duration_ms: 8000,
      poster_url: '/api/media/token',
      url: '/api/media/token2',
      decision_point_ms: null,
      has_poster: true,
    };
    renderTab([clip]);

    expect(screen.queryByRole('button', { name: /view question image/i })).toBeNull();
  });
});
