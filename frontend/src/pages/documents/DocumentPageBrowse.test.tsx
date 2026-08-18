/** A PLAYBOOK OPENS AS A PLAYBOOK.
 *
 * This screen was built as an authoring surface and never stopped being one.
 * A quiz picker was its first control, existing masks were drawn over the
 * page, and the last target quiz was restored from sessionStorage on mount -
 * so a coach coming back to READ their playbook landed in authoring mode with
 * boxes over the pages. Reading one was not reachable at all.
 *
 * The model these tests pin:
 *
 *     PLAYBOOK = reference     QUIZ = assessment
 *
 * Everything to do with making questions appears only after the coach asks
 * for it. The authoring machinery itself is unchanged and is covered by
 * DocumentPage.test.tsx, which now steps through the door first.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentPage } from './DocumentPage';
import * as documentsApi from '../../api/documents';
import * as quizzesApi from '../../api/quizzes';

const page1 = {
  id: 101,
  source_document_id: 3,
  page_number: 1,
  width_pt: 612,
  height_pt: 792,
  render_width: 1275,
  render_height: 1650,
  render_dpi: 150,
  aspect_ratio: 0.7727,
  has_full_render: true,
  image_url: '/api/media/v1.page1.sig',
  thumbnail_url: '/api/media/v1.thumb1.sig',
};

/** A question already built from this page. Its mask is the thing that used to
 *  sit over the reference material whether the coach wanted it or not. */
const regionQuestion = {
  id: 55,
  question_text: 'What coverage is this?',
  question_type: 'fill_blank',
  expected_answers: ['COVER 3'],
  region: { document_page_id: 101, x: 0.4, y: 0.2, width: 0.08, height: 0.015 },
};

function mockApis() {
  vi.spyOn(documentsApi, 'getDocument').mockResolvedValue({
    id: 3,
    title: 'CROWN',
    page_count: 1,
    byte_size: 1024,
    pages: [page1],
  } as never);
  vi.spyOn(documentsApi, 'getDocumentPage').mockResolvedValue(page1 as never);
  vi.spyOn(documentsApi, 'getPageTextRuns').mockResolvedValue([] as never);
  vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([
    { id: 7, title: 'Install' },
  ] as never);
  vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue({
    id: 7,
    title: 'Install',
    questions: [regionQuestion],
  } as never);
}

async function openPlaybook() {
  mockApis();
  render(
    <MemoryRouter initialEntries={['/documents/3']}>
      <Routes>
        <Route path="/documents/:documentId" element={<DocumentPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.findByAltText('CROWN, page 1');
}

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

afterEach(() => {
  sessionStorage.clear();
});

describe('opening a playbook', () => {
  it('shows the page', async () => {
    const image = await openPlaybook();

    expect(image).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'CROWN' })).toBeInTheDocument();
  });

  it('shows NO authoring controls', async () => {
    await openPlaybook();

    // Every one of these was permanently visible before.
    expect(screen.queryByLabelText('Add questions to')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Redo' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open quiz' })).toBeNull();
    expect(screen.queryByText(/click a play name/i)).toBeNull();
    expect(screen.queryByText(/on this page/i)).toBeNull();
  });

  it('draws no masks over the page', async () => {
    // THE ONE THAT MATTERS MOST for "it should feel like a playbook". The
    // quiz's existing question sits on this very page; browsing must not put
    // its box over the reference material.
    const image = await openPlaybook();

    expect(image.tagName).toBe('IMG');
    // A plain <img>, not the RegionDraw surface - so there is no overlay to
    // suppress and no draw affordance to disable.
    expect(image.parentElement?.querySelector('[data-region-id]')).toBeNull();
    expect(screen.queryByText('What coverage is this?')).toBeNull();
  });

  it('does not restore a previous authoring session', async () => {
    // The behaviour that made every return visit land in authoring mode. A
    // stale key must now be inert rather than re-entering the editor.
    sessionStorage.setItem('peira.playbook.lastQuizId', '7');

    await openPlaybook();

    expect(screen.queryByLabelText('Add questions to')).toBeNull();
  });

  it('offers one way in', async () => {
    await openPlaybook();

    expect(screen.getByRole('button', { name: 'Create questions' })).toBeInTheDocument();
  });
});

describe('stepping into authoring', () => {
  it('reveals the quiz picker, and the coach chooses once', async () => {
    await openPlaybook();

    await userEvent.click(screen.getByRole('button', { name: 'Create questions' }));

    expect(screen.getByLabelText('Add questions to')).toBeInTheDocument();
    // The prompt, not the select's own placeholder option - both say
    // "choose a quiz", so this has to name which one it means.
    expect(
      screen.getByText(/choose a quiz, then click a play name/i),
    ).toBeInTheDocument();
  });

  it('does not ask again for every question', async () => {
    // QUIZ-FIRST, chosen once. After picking, the picker keeps its value and
    // the coach works the page - no per-question destination prompt.
    await openPlaybook();
    await userEvent.click(screen.getByRole('button', { name: 'Create questions' }));

    await userEvent.selectOptions(screen.getByLabelText('Add questions to'), '7');

    expect(screen.getByLabelText('Add questions to')).toHaveValue('7');
    // This fixture's page has no text layer, so the instruction is the
    // drag one. Either way it is the AUTHORING instruction, which is the
    // point: the destination was chosen once and the coach is now working.
    await waitFor(() =>
      expect(screen.getByText(/drag a box over what you want to mask/i)).toBeInTheDocument(),
    );
  });

  it('brings the masks with it, because now they are the point', async () => {
    await openPlaybook();
    await userEvent.click(screen.getByRole('button', { name: 'Create questions' }));
    await userEvent.selectOptions(screen.getByLabelText('Add questions to'), '7');

    await waitFor(() =>
      expect(screen.getByText('What coverage is this?')).toBeInTheDocument(),
    );
  });

  it('goes back to a clean playbook when the coach is done', async () => {
    await openPlaybook();
    await userEvent.click(screen.getByRole('button', { name: 'Create questions' }));
    await userEvent.selectOptions(screen.getByLabelText('Add questions to'), '7');
    await waitFor(() =>
      expect(screen.getByText('What coverage is this?')).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.queryByLabelText('Add questions to')).toBeNull();
    expect(screen.queryByText('What coverage is this?')).toBeNull();
    expect(await screen.findByAltText('CROWN, page 1')).toBeInTheDocument();
  });
});
