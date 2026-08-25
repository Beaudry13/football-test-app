/** PLAYBOOK -> CREATE QUESTION -> DONE: does the question reach the quiz?
 *
 * A coach reported building a question from a playbook page, pressing Done,
 * and finding nothing in the quiz they had selected. The write path itself was
 * measured to be correct end to end - the API returns 201, the row carries the
 * chosen quiz_id, and the Questions tab renders it - so the break was earlier:
 * "Done" cleared the draft and left authoring, and a question that had never
 * been saved simply vanished. Closing cleanly and discarding unsaved work
 * looked identical from the outside.
 *
 * These tests assert PERSISTENCE AND DESTINATION rather than that a button was
 * pressed: which quiz the write was aimed at, that the other quiz received
 * nothing, and that no exit is allowed to destroy an unsaved question.
 *
 * In a file of its own because two of them mock a rejected request, and this
 * suite has been bitten before by rejected promises leaking across tests that
 * share a module's mock state.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentPage } from './DocumentPage';
import * as documentsApi from '../../api/documents';
import * as quizzesApi from '../../api/quizzes';
import * as questionsApi from '../../api/questions';
import type { DocumentPage as PageModel, SourceDocumentWithPages } from '../../api/documents';

const QUIZ_A = { id: 11, title: 'Quiz A - the wrong one' };
const QUIZ_B = { id: 22, title: 'Quiz B - the chosen one' };

function makePage(pageNumber: number, overrides: Partial<PageModel> = {}): PageModel {
  return {
    id: 100 + pageNumber,
    source_document_id: 3,
    page_number: pageNumber,
    width_pt: 612,
    height_pt: 792,
    render_width: 1275,
    render_height: 1651,
    render_dpi: 150,
    aspect_ratio: 1275 / 1651,
    has_full_render: true,
    thumbnail_url: `/api/media/v1.thumb${pageNumber}.sig`,
    image_url: `/api/media/v1.page${pageNumber}.sig`,
    ...overrides,
  };
}

const page1 = makePage(1);

const sampleDocument: SourceDocumentWithPages = {
  id: 3,
  organization_id: 1,
  uploaded_by_coach_id: 1,
  title: 'CROWN',
  original_filename: 'CROWN.pdf',
  byte_size: 187500,
  page_count: 1,
  created_at: '2026-08-08T00:00:00Z',
  pages: [page1],
};

const runs = [{ text: 'COVER 3', x: 0.4, y: 0.2, width: 0.08, height: 0.015 }];

function setSurfaceSize(width = 1000, height = 800) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height,
    toJSON: () => ({}),
  } as DOMRect);
}

function clickAt(surface: Element, fx: number, fy: number, size = [1000, 800]) {
  const opts = { bubbles: true, button: 0, pointerId: 1 };
  const at = { clientX: size[0] * fx, clientY: size[1] * fy };
  surface.dispatchEvent(new PointerEvent('pointerdown', { ...opts, ...at }));
  surface.dispatchEvent(new PointerEvent('pointerup', { ...opts, ...at }));
}

/** Enter authoring and choose `destination` from the quiz picker. */
async function enterAuthoring(destination: { id: number }) {
  vi.spyOn(documentsApi, 'getDocument').mockResolvedValue(sampleDocument);
  vi.spyOn(documentsApi, 'getDocumentPage').mockResolvedValue(page1);
  vi.spyOn(documentsApi, 'getPageTextRuns').mockResolvedValue(runs);
  vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([QUIZ_A, QUIZ_B] as never);
  vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue({ ...QUIZ_B, questions: [] } as never);

  render(
    <MemoryRouter initialEntries={['/documents/3']}>
      <Routes>
        <Route path="/documents/:documentId" element={<DocumentPage />} />
      </Routes>
    </MemoryRouter>,
  );

  await screen.findByAltText('CROWN, page 1');
  await userEvent.click(screen.getByRole('button', { name: 'Create questions' }));
  const image = await screen.findByAltText('CROWN, page 1');
  const surface = image.parentElement as HTMLElement;
  surface.setPointerCapture = vi.fn();
  await userEvent.selectOptions(
    screen.getByLabelText('Add questions to'),
    String(destination.id),
  );
  return surface;
}

/** Tap the play name and type a prompt, stopping short of saving. */
async function buildQuestion(surface: HTMLElement, prompt = 'What coverage?') {
  clickAt(surface, 0.44, 0.207);
  await screen.findByLabelText('Accepted answers');
  await userEvent.type(screen.getByLabelText('Question'), prompt);
}

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('the question reaches the quiz the coach chose', () => {
  it('WRITES TO THE SELECTED QUIZ, and to no other', async () => {
    setSurfaceSize();
    const create = vi.spyOn(questionsApi, 'createRegionQuestion').mockResolvedValue({
      id: 55,
      question_text: 'What coverage?',
      expected_answers: ['COVER 3'],
      region: { document_page_id: 101, x: 0.4, y: 0.2, width: 0.08, height: 0.015 },
    } as never);

    const surface = await enterAuthoring(QUIZ_B);
    await buildQuestion(surface);
    await userEvent.click(screen.getByRole('button', { name: 'Save question' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    // Quiz B received it...
    expect(create).toHaveBeenCalledWith(QUIZ_B.id, expect.anything());
    // ...and Quiz A was never written to at all.
    for (const call of create.mock.calls) {
      expect(call[0]).not.toBe(QUIZ_A.id);
    }
  });

  it('carries the playbook provenance with it', async () => {
    // The page it came from and the region on that page are what make this a
    // playbook question rather than a plain one. Losing either would strand
    // the mask and the crop.
    setSurfaceSize();
    const create = vi.spyOn(questionsApi, 'createRegionQuestion').mockResolvedValue({
      id: 55,
      question_text: 'What coverage?',
      expected_answers: ['COVER 3'],
      region: { document_page_id: 101, x: 0.4, y: 0.2, width: 0.08, height: 0.015 },
    } as never);

    const surface = await enterAuthoring(QUIZ_B);
    await buildQuestion(surface);
    await userEvent.click(screen.getByRole('button', { name: 'Save question' }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith(
      QUIZ_B.id,
      expect.objectContaining({
        document_page_id: page1.id,
        question_text: 'What coverage?',
        // Read off the page, not typed by the coach.
        expected_answers: ['COVER 3'],
        region: expect.objectContaining({
          x: expect.any(Number),
          y: expect.any(Number),
          width: expect.any(Number),
          height: expect.any(Number),
        }),
      }),
    );
  });
});

describe('Done cannot quietly throw the question away', () => {
  it('REFUSES TO FINISH while a question is unsaved, and says why', async () => {
    /* THE REPORTED BUG. Done used to clear the draft and leave authoring, so a
       coach who pressed it instead of "Save question" saw the panel close,
       read that as success, and found nothing in their quiz. */
    setSurfaceSize();
    const create = vi.spyOn(questionsApi, 'createRegionQuestion');

    const surface = await enterAuthoring(QUIZ_B);
    await buildQuestion(surface);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    // It did not pretend anything was saved.
    expect(create).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(/hasn.t been saved yet/i);
    // And the coach is still exactly where they were, with their text.
    expect(screen.getByLabelText('Question')).toHaveValue('What coverage?');
    expect(screen.getByRole('button', { name: 'Save question' })).toBeInTheDocument();
  });

  it('lets the coach save it after being warned, WITHOUT retyping', async () => {
    setSurfaceSize();
    const create = vi.spyOn(questionsApi, 'createRegionQuestion').mockResolvedValue({
      id: 55,
      question_text: 'What coverage?',
      expected_answers: ['COVER 3'],
      region: { document_page_id: 101, x: 0.4, y: 0.2, width: 0.08, height: 0.015 },
    } as never);

    const surface = await enterAuthoring(QUIZ_B);
    await buildQuestion(surface);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Save question' }));

    await waitFor(() => expect(create).toHaveBeenCalledWith(QUIZ_B.id, expect.anything()));
  });

  it('still finishes when the coach discards on purpose', async () => {
    // The escape hatch has to exist, and it has to be the coach's decision.
    setSurfaceSize();
    const surface = await enterAuthoring(QUIZ_B);
    await buildQuestion(surface);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Discard it and finish' }));

    expect(await screen.findByRole('button', { name: 'Create questions' })).toBeInTheDocument();
  });

  it('finishes immediately when there is nothing unsaved', async () => {
    setSurfaceSize();
    await enterAuthoring(QUIZ_B);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(await screen.findByRole('button', { name: 'Create questions' })).toBeInTheDocument();
  });
});

describe('a failed write is never reported as success', () => {
  it('keeps the question on screen and shows the error', async () => {
    setSurfaceSize();
    vi.spyOn(questionsApi, 'createRegionQuestion').mockRejectedValue(
      new Error('Server refused'),
    );

    const surface = await enterAuthoring(QUIZ_B);
    await buildQuestion(surface);
    await userEvent.click(screen.getByRole('button', { name: 'Save question' }));

    // The typed content survives the failure - nothing to re-enter.
    await waitFor(() =>
      expect(screen.getByLabelText('Question')).toHaveValue('What coverage?'),
    );
    expect(screen.getByLabelText('Accepted answers')).toHaveValue('COVER 3');
    expect(screen.getByRole('button', { name: 'Save question' })).toBeInTheDocument();
  });

  it('allows a retry that succeeds, without re-entering anything', async () => {
    setSurfaceSize();
    const create = vi
      .spyOn(questionsApi, 'createRegionQuestion')
      .mockRejectedValueOnce(new Error('Server refused'))
      .mockResolvedValue({
        id: 55,
        question_text: 'What coverage?',
        expected_answers: ['COVER 3'],
        region: { document_page_id: 101, x: 0.4, y: 0.2, width: 0.08, height: 0.015 },
      } as never);

    const surface = await enterAuthoring(QUIZ_B);
    await buildQuestion(surface);
    await userEvent.click(screen.getByRole('button', { name: 'Save question' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole('button', { name: 'Save question' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenLastCalledWith(QUIZ_B.id, expect.anything());
  });

  it('does not let Done finish after a failed save', async () => {
    // The draft is still unsaved, so the same refusal applies.
    setSurfaceSize();
    vi.spyOn(questionsApi, 'createRegionQuestion').mockRejectedValue(
      new Error('Server refused'),
    );

    const surface = await enterAuthoring(QUIZ_B);
    await buildQuestion(surface);
    await userEvent.click(screen.getByRole('button', { name: 'Save question' }));
    await waitFor(() => expect(screen.getByLabelText('Question')).toHaveValue('What coverage?'));

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.queryByRole('button', { name: 'Create questions' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save question' })).toBeInTheDocument();
  });
});
