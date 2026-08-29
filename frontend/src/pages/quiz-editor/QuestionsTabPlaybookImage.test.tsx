/** A QUESTION CUT FROM A PLAYBOOK PAGE MUST SHOW THAT PAGE.
 *
 * The reported bug: a coach goes Playbook -> Create questions -> pick a quiz
 * -> draw a region -> Save, opens the destination quiz, and the question is
 * there with the right text and no picture at all.
 *
 * Nothing was lost. The region, its coordinates and its page were all stored
 * correctly, and the server returned a signed `masked_image_url` for them -
 * the PLAYER had been rendering it the whole time. This list only ever read
 * `image`, the uploaded-film-still field, which a region-backed question does
 * not have and never will. So the coach's copy and the player's copy of the
 * same question disagreed about whether it had a picture.
 *
 * These tests are written against that contract rather than against the
 * markup: given what the API actually returns for each kind of question, the
 * list must show the right picture, the right number of pictures, and must
 * never invent one.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { QuestionsTab } from './QuestionsTab';
import type { Question, Quiz } from '../../api/types';

vi.mock('../../api/questions', () => ({
  createQuestion: vi.fn(),
  deleteQuestion: vi.fn(),
  reorderQuestions: vi.fn(),
  updateQuestion: vi.fn(),
  retireQuestion: vi.fn().mockResolvedValue({}),
  restoreQuestion: vi.fn().mockResolvedValue({}),
}));

/** Shaped from a real payload: this is what GET /api/quizzes/:id returns for a
 *  question created through Playbook -> Create questions. `image` is null,
 *  `needs_image` is false, and the picture is the masked render. */
const fromPlaybook = (over: Partial<Question> = {}): Question =>
  ({
    id: 561,
    quiz_id: 500,
    question_text: 'What coverage is this?',
    question_type: 'fill_blank',
    position: 0,
    options: [],
    expected_answers: ['Cover 3 Buzz'],
    image: null,
    needs_image: false,
    masked_image_url: '/api/media/v1.signed-token-for-question-561',
    region: {
      id: 19,
      question_id: 561,
      document_page_id: 106,
      source_document_id: 17,
      page_number: 1,
      role: 'mask',
      x: 0.55,
      y: 0.785,
      width: 0.3,
      height: 0.03,
    },
    ...over,
  }) as unknown as Question;

/** An ordinary question with an uploaded film still - the case that always
 *  worked, kept here so a fix for the one above cannot break it. */
const withUploadedImage = (over: Partial<Question> = {}): Question =>
  ({
    id: 12,
    quiz_id: 500,
    question_text: 'Who has the flat?',
    question_type: 'true_false',
    position: 1,
    options: [],
    image: { id: 3, question_id: 12, image_url: '/uploads/play.jpg', annotations: [] },
    needs_image: false,
    ...over,
  }) as unknown as Question;

/** Text-only: no upload, no region. Must stay pictureless. */
const textOnly = (over: Partial<Question> = {}): Question =>
  ({
    id: 30,
    quiz_id: 500,
    question_text: 'Trips right, Mike is where?',
    question_type: 'true_false',
    position: 2,
    options: [],
    image: null,
    needs_image: false,
    ...over,
  }) as unknown as Question;

function renderTab(questions: Question[]) {
  const quiz = { id: 500, title: 'Coverage Responsibility', questions } as unknown as Quiz;
  return render(
    <MemoryRouter initialEntries={['/quizzes/500']}>
      <Routes>
        <Route
          path="/quizzes/500"
          element={<QuestionsTab quiz={quiz} reload={vi.fn().mockResolvedValue(undefined)} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('a question created from a playbook region', () => {
  it('shows the playbook page it was cut from', () => {
    // THE REGRESSION. Before the fix this found nothing: the list rendered
    // only `image`, and a region-backed question has none.
    renderTab([fromPlaybook()]);

    const picture = screen.getByAltText('Playbook page with the answer covered');
    expect(picture).toBeInTheDocument();
    expect(picture.getAttribute('src')).toContain('/api/media/v1.signed-token-for-question-561');
  });

  it('shows the masked render, never an unmasked page built from the region', () => {
    // The region carries a page id and coordinates, which is enough to
    // construct a URL to the raw page. Doing that would hand the coach a
    // different picture from the one the player gets, and would put an
    // unmasked page behind a signed-URL boundary that exists to prevent
    // exactly that. The masked render is the only picture for this question.
    renderTab([fromPlaybook()]);

    const picture = screen.getByAltText('Playbook page with the answer covered');
    expect(picture.getAttribute('src')).not.toContain('/documents/');
    expect(picture.getAttribute('src')).not.toContain('/pages/');
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('shows no picture when the server supplied no masked render', () => {
    // Matching QuestionInput's rule exactly: no masked render means no
    // picture, never a guess.
    renderTab([fromPlaybook({ masked_image_url: null } as Partial<Question>)]);

    expect(screen.queryByAltText('Playbook page with the answer covered')).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('the other kinds of question in the same list', () => {
  it('still shows an uploaded film still, and calls it that', () => {
    renderTab([withUploadedImage()]);

    const picture = screen.getByAltText('Question film');
    expect(picture.getAttribute('src')).toContain('/uploads/play.jpg');
  });

  it('leaves a text-only question with no picture', () => {
    renderTab([textOnly()]);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('gives each question its own picture when the list mixes all three', () => {
    // The real destination quiz in the bug report is exactly this shape: a
    // couple of hand-written questions, then a run cut from a playbook.
    renderTab([fromPlaybook(), withUploadedImage(), textOnly()]);

    expect(screen.getByAltText('Playbook page with the answer covered')).toBeInTheDocument();
    expect(screen.getByAltText('Question film')).toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(2);
  });
});
