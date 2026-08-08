import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentPage } from './DocumentPage';
import * as documentsApi from '../../api/documents';
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
