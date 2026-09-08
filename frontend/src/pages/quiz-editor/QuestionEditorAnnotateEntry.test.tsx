import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { QuestionsTab } from './QuestionsTab';
import type { Question, Quiz } from '../../api/types';

/** A COACH MUST BE ABLE TO COME BACK TO A DRAWING LATER.
 *
 * THE REPORTED REGRESSION. Annotating an image was reachable from a banner
 * that appears once - immediately after a photo is added, and gone the moment
 * the coach does anything else - and from an overflow menu item labelled
 * "Edit image", which reads as "replace the file" rather than "draw on it".
 * The control actually labelled Edit opened a form that said "you can annotate
 * it afterwards" and contained no route to do so; it did not even show the
 * picture. So the normal workflow - add image, annotate, move on, come back -
 * dead-ended at the most obvious button on the row.
 *
 * The data was never the problem: GET /api/quizzes/:id already returns each
 * image with its annotations and canvas_width, and AnnotationPage already
 * loads any question by id. This is about exposing the existing route.
 *
 * NO NEW EDITOR AND NO DUPLICATED STATE. The action is a Link to the existing
 * AnnotationPage, which owns the canvas and the saving.
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

vi.mock('../../api/concepts', () => ({
  listConcepts: vi.fn(async () => []),
  createConcept: vi.fn(),
}));

function imageQuestion(id: number, imageUrl: string, text: string): Question {
  return {
    id,
    quiz_id: 7,
    question_text: text,
    question_type: 'written',
    position: id,
    options: [],
    image: {
      id: id * 10,
      question_id: id,
      image_url: imageUrl,
      annotations: [{ type: 'Circle', left: 10, top: 10, radius: 5 }],
      canvas_width: 900,
    },
    needs_image: false,
    clip: null,
    masked_image_url: null,
    region: null,
  } as unknown as Question;
}

function renderTab(questions: Question[]) {
  return render(
    <MemoryRouter>
      <QuestionsTab
        quiz={{ id: 7, title: 'Cover 3 install', status: 'draft', questions } as unknown as Quiz}
        reload={() => Promise.resolve()}
      />
    </MemoryRouter>,
  );
}

/** The row's own Edit button - the control a coach actually reaches for. */
function openEditor(index = 0) {
  fireEvent.click(screen.getAllByRole('button', { name: /^edit$/i })[index]);
}

describe('editing a question that already has an image', () => {
  it('shows the picture that is attached to it', () => {
    // It used to show nothing at all: the preview state only ever held a
    // newly-picked file, so editing an existing question displayed no image.
    renderTab([imageQuestion(1, '/uploads/cover3.jpg', 'Which coverage?')]);
    openEditor();

    expect(screen.getByAltText(/current question image/i)).toHaveAttribute(
      'src',
      expect.stringContaining('/uploads/cover3.jpg'),
    );
  });

  it('offers an Edit / Annotate action', () => {
    renderTab([imageQuestion(1, '/uploads/cover3.jpg', 'Which coverage?')]);
    openEditor();

    expect(screen.getByRole('link', { name: /annotate/i })).toBeInTheDocument();
  });

  it('the action routes to the annotation page for THAT question', () => {
    // THE CASE THAT WAS BROKEN: an older question, reached long after the
    // one-time "Annotate now" banner has gone. The href must name this
    // question, not the most recent one.
    renderTab([
      imageQuestion(3, '/uploads/older.jpg', 'An older question'),
      imageQuestion(9, '/uploads/newer.jpg', 'A newer question'),
    ]);
    openEditor(0);

    expect(screen.getByRole('link', { name: /annotate/i })).toHaveAttribute(
      'href',
      '/quizzes/7/questions/3/annotate',
    );
  });

  it('the older question shows its OWN image, not the newest one', () => {
    renderTab([
      imageQuestion(3, '/uploads/older.jpg', 'An older question'),
      imageQuestion(9, '/uploads/newer.jpg', 'A newer question'),
    ]);
    openEditor(0);

    expect(screen.getByAltText(/current question image/i)).toHaveAttribute(
      'src',
      expect.stringContaining('/uploads/older.jpg'),
    );
  });
});

describe('where the entry point must NOT appear', () => {
  it('not for a question with no image', () => {
    const bare = imageQuestion(1, '', 'Written only');
    (bare as { image: unknown }).image = null;
    renderTab([bare]);
    openEditor();

    expect(screen.queryByRole('link', { name: /annotate/i })).toBeNull();
  });

  it('not for a clip question - a moving picture has no frame to draw on', () => {
    const clip = imageQuestion(1, '', 'Read the leverage');
    (clip as { image: unknown }).image = null;
    (clip as { clip: unknown }).clip = {
      id: 5,
      question_id: 1,
      content_type: 'video/mp4',
      duration_ms: 8000,
      decision_point_ms: null,
      has_poster: true,
    };
    renderTab([clip]);
    openEditor();

    expect(screen.queryByRole('link', { name: /annotate/i })).toBeNull();
  });

  it('not for a playbook-backed question, whose picture comes from its region', () => {
    const region = imageQuestion(1, '', 'From the playbook');
    (region as { image: unknown }).image = null;
    (region as { region: unknown }).region = { id: 2, page_id: 4 };
    (region as { masked_image_url: unknown }).masked_image_url = '/api/media/masked';
    renderTab([region]);
    openEditor();

    expect(screen.queryByRole('link', { name: /annotate/i })).toBeNull();
  });
});
