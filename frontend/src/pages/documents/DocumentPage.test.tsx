import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentPage } from './DocumentPage';
import * as documentsApi from '../../api/documents';
import * as quizzesApi from '../../api/quizzes';
import * as questionsApi from '../../api/questions';
import type { DocumentPage as PageModel, SourceDocumentWithPages } from '../../api/documents';

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
    has_full_render: false,
    thumbnail_url: `/api/media/v1.thumb${pageNumber}.sig`,
    image_url: null,
    ...overrides,
  };
}

const sampleDocument: SourceDocumentWithPages = {
  id: 3,
  organization_id: 1,
  uploaded_by_coach_id: 1,
  title: 'CROWN',
  original_filename: 'CROWN.pdf',
  byte_size: 187500,
  page_count: 2,
  created_at: '2026-08-08T00:00:00Z',
  pages: [makePage(1), makePage(2)],
};

function renderDocument() {
  render(
    <MemoryRouter initialEntries={['/documents/3']}>
      <Routes>
        <Route path="/documents/:documentId" element={<DocumentPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('DocumentPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // The page loads the coach's quizzes so they can pick where questions go.
    // Every test needs it; only the authoring ones care what it returns.
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([]);
  });

  it('shows the playbook title and page count', async () => {
    vi.spyOn(documentsApi, 'getDocument').mockResolvedValue(sampleDocument);
    vi.spyOn(documentsApi, 'getDocumentPage').mockResolvedValue(
      makePage(1, { has_full_render: true, image_url: '/api/media/v1.page1.sig' }),
    );
    renderDocument();

    expect(await screen.findByRole('heading', { name: 'CROWN' })).toBeInTheDocument();
    expect(screen.getByText('2 pages')).toBeInTheDocument();
  });

  it('renders a thumbnail button per page', async () => {
    vi.spyOn(documentsApi, 'getDocument').mockResolvedValue(sampleDocument);
    vi.spyOn(documentsApi, 'getDocumentPage').mockResolvedValue(
      makePage(1, { has_full_render: true, image_url: '/api/media/v1.page1.sig' }),
    );
    renderDocument();

    expect(await screen.findByAltText('Page 1')).toBeInTheDocument();
    expect(screen.getByAltText('Page 2')).toBeInTheDocument();
  });

  it('opens page 1 automatically rather than showing an empty frame', async () => {
    vi.spyOn(documentsApi, 'getDocument').mockResolvedValue(sampleDocument);
    const getPage = vi
      .spyOn(documentsApi, 'getDocumentPage')
      .mockResolvedValue(makePage(1, { has_full_render: true, image_url: '/api/media/v1.page1.sig' }));
    renderDocument();

    await waitFor(() => expect(getPage).toHaveBeenCalledWith(3, 1));
    expect(await screen.findByAltText('CROWN, page 1')).toBeInTheDocument();
  });

  it('fetches the full render when another page is opened', async () => {
    vi.spyOn(documentsApi, 'getDocument').mockResolvedValue(sampleDocument);
    const getPage = vi
      .spyOn(documentsApi, 'getDocumentPage')
      .mockImplementation(async (_id, pageNumber) =>
        makePage(pageNumber, {
          has_full_render: true,
          image_url: `/api/media/v1.page${pageNumber}.sig`,
        }),
      );
    renderDocument();

    await screen.findByAltText('CROWN, page 1');
    await userEvent.click(screen.getByAltText('Page 2'));

    await waitFor(() => expect(getPage).toHaveBeenCalledWith(3, 2));
    expect(await screen.findByAltText('CROWN, page 2')).toBeInTheDocument();
  });

  it('shows a rendering state while the first full render is produced', async () => {
    vi.spyOn(documentsApi, 'getDocument').mockResolvedValue(sampleDocument);
    // A page's raster does not exist until it is first opened, so this wait
    // is real and must be shown rather than looking like a broken image.
    let release: (page: PageModel) => void = () => {};
    vi.spyOn(documentsApi, 'getDocumentPage').mockReturnValue(
      new Promise<PageModel>((resolve) => {
        release = resolve;
      }),
    );
    renderDocument();

    expect(await screen.findByText('Rendering page')).toBeInTheDocument();
    release(makePage(1, { has_full_render: true, image_url: '/api/media/v1.page1.sig' }));
    expect(await screen.findByAltText('CROWN, page 1')).toBeInTheDocument();
  });

  it('surfaces a load failure instead of hanging on the spinner', async () => {
    vi.spyOn(documentsApi, 'getDocument').mockRejectedValue(new Error('nope'));
    renderDocument();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('never builds a media URL by hand', async () => {
    // Signed URLs are short-lived and minted per response. A component that
    // constructed one from an id would produce a permanently broken image,
    // so it must only ever use what the API handed it.
    vi.spyOn(documentsApi, 'getDocument').mockResolvedValue(sampleDocument);
    vi.spyOn(documentsApi, 'getDocumentPage').mockResolvedValue(
      makePage(1, { has_full_render: true, image_url: '/api/media/v1.page1.sig' }),
    );
    renderDocument();

    const image = await screen.findByAltText('CROWN, page 1');
    expect(image.getAttribute('src')).toContain('/api/media/v1.page1.sig');
  });
});

describe('DocumentPage tap-to-select authoring', () => {
  const quiz = { id: 7, title: 'Install 1' };
  const page1 = makePage(1, { has_full_render: true, image_url: '/api/media/v1.page1.sig' });

  /** COVER 3 sits mid-page; the rest of the page is diagram. */
  const runs = [
    { text: 'COVER 3', x: 0.4, y: 0.2, width: 0.08, height: 0.015 },
    { text: 'TEX', x: 0.4, y: 0.25, width: 0.04, height: 0.015 },
  ];

  function setSurfaceSize(width = 1000, height = 800) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height,
      toJSON: () => ({}),
    } as DOMRect);
  }

  /** Click (no movement) at a page fraction. */
  function clickAt(surface: Element, fx: number, fy: number, size = [1000, 800]) {
    const opts = { bubbles: true, button: 0, pointerId: 1 };
    const at = { clientX: size[0] * fx, clientY: size[1] * fy };
    surface.dispatchEvent(new PointerEvent('pointerdown', { ...opts, ...at }));
    surface.dispatchEvent(new PointerEvent('pointerup', { ...opts, ...at }));
  }

  function dragAt(surface: Element, from: [number, number], to: [number, number], size = [1000, 800]) {
    const opts = { bubbles: true, button: 0, pointerId: 1 };
    surface.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: size[0] * from[0], clientY: size[1] * from[1] }));
    surface.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: size[0] * to[0], clientY: size[1] * to[1] }));
    surface.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: size[0] * to[0], clientY: size[1] * to[1] }));
  }

  async function renderReady(withRuns = runs) {
    vi.spyOn(documentsApi, 'getDocument').mockResolvedValue({
      ...sampleDocument, pages: [page1],
    });
    vi.spyOn(documentsApi, 'getDocumentPage').mockResolvedValue(page1);
    vi.spyOn(documentsApi, 'getPageTextRuns').mockResolvedValue(withRuns);
    vi.spyOn(quizzesApi, 'listQuizzes').mockResolvedValue([quiz] as never);
    vi.spyOn(quizzesApi, 'getQuiz').mockResolvedValue({ ...quiz, questions: [] } as never);

    render(
      <MemoryRouter initialEntries={['/documents/3']}>
        <Routes>
          <Route path="/documents/:documentId" element={<DocumentPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const image = await screen.findByAltText('CROWN, page 1');
    const surface = image.parentElement as HTMLElement;
    surface.setPointerCapture = vi.fn();
    await userEvent.selectOptions(screen.getByLabelText('Add questions to'), '7');
    return surface;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it('a click on a play name fills the answer from the PDF', async () => {
    setSurfaceSize();
    const surface = await renderReady();

    clickAt(surface, 0.44, 0.207);

    // THE speed win: the coach types nothing. The answer was already on the
    // page and the system just read it to them.
    expect(await screen.findByLabelText('Accepted answers')).toHaveValue('COVER 3');
  });

  it('a click slightly off a run still selects it', async () => {
    // Diagram labels are ~9px wide; requiring a dead-on hit would make tap
    // useless exactly where it is most valuable.
    setSurfaceSize();
    const surface = await renderReady();

    clickAt(surface, 0.4 + 0.085, 0.207);

    expect(await screen.findByLabelText('Accepted answers')).toHaveValue('COVER 3');
  });

  it('a click on empty page opens nothing', async () => {
    setSurfaceSize();
    const surface = await renderReady();

    clickAt(surface, 0.05, 0.9);

    await waitFor(() =>
      expect(screen.queryByLabelText('Accepted answers')).not.toBeInTheDocument(),
    );
  });

  it('a drag still creates a rectangle, with no answer prefilled', async () => {
    // Hybrid: the same page, the same surface, no mode switch. A diagram has
    // no text to tap, so drag has to keep working alongside tap.
    setSurfaceSize();
    const surface = await renderReady();

    dragAt(surface, [0.1, 0.6], [0.3, 0.7]);

    expect(await screen.findByLabelText('Accepted answers')).toHaveValue('');
  });

  it('works on a page with no text layer at all', async () => {
    // A scanned playbook. Drag must remain fully functional.
    setSurfaceSize();
    const surface = await renderReady([]);

    expect(screen.getByText(/no selectable text/i)).toBeInTheDocument();
    dragAt(surface, [0.1, 0.6], [0.3, 0.7]);
    expect(await screen.findByLabelText('Accepted answers')).toBeInTheDocument();
  });

  it('remembers the target quiz between visits', async () => {
    setSurfaceSize();
    await renderReady();
    // Choosing the quiz again on every visit is a click that buys nothing.
    expect(sessionStorage.getItem('peira.playbook.lastQuizId')).toBe('7');
  });

  it('creates the question from a tap and reports it', async () => {
    setSurfaceSize();
    const create = vi.spyOn(questionsApi, 'createRegionQuestion').mockResolvedValue({
      id: 55, question_text: 'What is this?', expected_answers: ['COVER 3'],
      region: { document_page_id: 101, x: 0.4, y: 0.2, width: 0.08, height: 0.015 },
    } as never);
    const surface = await renderReady();

    clickAt(surface, 0.44, 0.207);
    await screen.findByLabelText('Accepted answers');
    await userEvent.type(screen.getByLabelText('Question'), 'What is this?');
    await userEvent.click(screen.getByRole('button', { name: 'Save question' }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(7, expect.objectContaining({
        expected_answers: ['COVER 3'],
        question_text: 'What is this?',
      })),
    );
  });
});
