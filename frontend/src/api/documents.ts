import { api } from './client';

/** A page of an uploaded source document.
 *
 * NOTE the two url fields. They are short-lived SIGNED urls, minted per
 * response - not durable addresses. Do not cache them, store them, or build
 * them by hand: they expire, and after they do the image 404s. Re-fetch the
 * document (or the page) to get fresh ones.
 *
 * `render_width`/`render_height` describe the raster. They do NOT define where
 * anything is - regions are stored in normalised 0-1 coordinates so they stay
 * correct if a page is ever re-rendered at another resolution. The contract is
 * in backend/app/services/document_geometry.py.
 */
export interface DocumentPage {
  id: number;
  source_document_id: number;
  page_number: number;
  width_pt: number;
  height_pt: number;
  render_width: number;
  render_height: number;
  render_dpi: number;
  /** Lets the page strip reserve the right box before any image loads, so it
   *  does not reflow as thumbnails arrive. */
  aspect_ratio: number | null;
  /** False until a coach opens the page for the first time. */
  has_full_render: boolean;
  thumbnail_url: string | null;
  image_url: string | null;
}

/** An uploaded document. The original PDF is never addressable - there is
 *  deliberately no field here that could reach it. */
export interface SourceDocument {
  id: number;
  organization_id: number;
  uploaded_by_coach_id: number | null;
  title: string;
  original_filename: string;
  byte_size: number;
  page_count: number;
  created_at: string | null;
}

export interface SourceDocumentWithPages extends SourceDocument {
  pages: DocumentPage[];
}

export function listDocuments(): Promise<SourceDocument[]> {
  return api.get<SourceDocument[]>('/documents');
}

export function getDocument(documentId: number): Promise<SourceDocumentWithPages> {
  return api.get<SourceDocumentWithPages>(`/documents/${documentId}`);
}

export function uploadDocument(file: File): Promise<SourceDocumentWithPages> {
  const formData = new FormData();
  formData.append('file', file);
  return api.postForm<SourceDocumentWithPages>('/documents', formData);
}

/** Fetches one page, rendering it at full resolution server-side if this is
 *  the first time anyone has opened it. That first call is slower by design -
 *  it is the only time the page is ever rendered. */
export function getDocumentPage(documentId: number, pageNumber: number): Promise<DocumentPage> {
  return api.get<DocumentPage>(`/documents/${documentId}/pages/${pageNumber}`);
}

export function renameDocument(documentId: number, title: string): Promise<SourceDocument> {
  return api.patch<SourceDocument>(`/documents/${documentId}`, { title });
}

export function deleteDocument(documentId: number): Promise<void> {
  return api.delete<void>(`/documents/${documentId}`);
}
