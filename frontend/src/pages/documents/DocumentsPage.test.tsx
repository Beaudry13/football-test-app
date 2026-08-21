import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentsPage } from './DocumentsPage';
import * as documentsApi from '../../api/documents';
import { acceptConfirm } from '../../test/confirmDialog';
import type { SourceDocument, SourceDocumentWithPages } from '../../api/documents';

const sampleDocument: SourceDocument = {
  id: 3,
  organization_id: 1,
  uploaded_by_coach_id: 1,
  title: 'CROWN',
  original_filename: 'CROWN.pdf',
  byte_size: 187500,
  page_count: 2,
  created_at: '2026-08-08T00:00:00Z',
};

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function renderDocuments() {
  render(
    <MemoryRouter>
      <DocumentsPage />
    </MemoryRouter>,
  );
}

describe('DocumentsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockNavigate.mockReset();
  });

  it('shows the empty state when nothing has been uploaded', async () => {
    vi.spyOn(documentsApi, 'listDocuments').mockResolvedValue([]);
    renderDocuments();

    expect(
      await screen.findByText(/Upload a PDF and its pages appear here/),
    ).toBeInTheDocument();
  });

  it('lists playbooks with their page count and size', async () => {
    vi.spyOn(documentsApi, 'listDocuments').mockResolvedValue([sampleDocument]);
    renderDocuments();

    expect(await screen.findByText('CROWN')).toBeInTheDocument();
    expect(screen.getByText(/2 pages/)).toBeInTheDocument();
    expect(screen.getByText(/0\.2 MB/)).toBeInTheDocument();
  });

  it('says "page" rather than "pages" for a one-page document', async () => {
    vi.spyOn(documentsApi, 'listDocuments').mockResolvedValue([
      { ...sampleDocument, page_count: 1 },
    ]);
    renderDocuments();

    expect(await screen.findByText(/1 page ·/)).toBeInTheDocument();
  });

  it('uploads a PDF and goes straight into it', async () => {
    // Uploading was never the goal - the coach came to build questions, so
    // landing them back on a list would be a step for its own sake.
    vi.spyOn(documentsApi, 'listDocuments').mockResolvedValue([]);
    const upload = vi
      .spyOn(documentsApi, 'uploadDocument')
      .mockResolvedValue({ ...sampleDocument, pages: [] } as SourceDocumentWithPages);
    renderDocuments();
    await screen.findByText(/Upload a PDF and its pages/);

    const file = new File(['%PDF-1.7'], 'CROWN.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('Upload PDF'), file);

    await waitFor(() => expect(upload).toHaveBeenCalledWith(file));
    expect(mockNavigate).toHaveBeenCalledWith('/documents/3');
  });

  it('surfaces an upload failure and stays on the page', async () => {
    vi.spyOn(documentsApi, 'listDocuments').mockResolvedValue([]);
    vi.spyOn(documentsApi, 'uploadDocument').mockRejectedValue(
      new Error('That PDF is password-protected.'),
    );
    renderDocuments();
    await screen.findByText(/Upload a PDF and its pages/);

    await userEvent.upload(
      screen.getByLabelText('Upload PDF'),
      new File(['x'], 'locked.pdf', { type: 'application/pdf' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('password-protected');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('deletes a playbook after confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(documentsApi, 'listDocuments').mockResolvedValue([sampleDocument]);
    const remove = vi.spyOn(documentsApi, 'deleteDocument').mockResolvedValue(undefined);
    renderDocuments();

    // Delete is behind the row's "..." now - opening the playbook is the
    // primary action and deleting it is maintenance, the same arrangement
    // quiz cards and folder rows use. The confirmation is unchanged.
    await user.click(
      await screen.findByRole('button', { name: `Options for ${sampleDocument.title}` }),
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete playbook' }));
    await acceptConfirm(user, 'Delete Playbook');

    await waitFor(() => expect(remove).toHaveBeenCalledWith(3));
  });

  it('keeps Delete out of the row itself', async () => {
    // The whole point: a destructive action should not be the
    // highest-contrast control sitting beside the link a coach came to press.
    vi.spyOn(documentsApi, 'listDocuments').mockResolvedValue([sampleDocument]);
    renderDocuments();
    await screen.findByText(sampleDocument.title);

    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('only accepts PDFs at the file picker', async () => {
    vi.spyOn(documentsApi, 'listDocuments').mockResolvedValue([]);
    renderDocuments();
    await screen.findByText(/Upload a PDF and its pages/);

    expect(screen.getByLabelText('Upload PDF')).toHaveAttribute(
      'accept',
      'application/pdf,.pdf',
    );
  });
});
