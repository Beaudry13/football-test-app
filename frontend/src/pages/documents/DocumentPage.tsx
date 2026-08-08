import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getDocument, getDocumentPage } from '../../api/documents';
import type { DocumentPage as PageModel, SourceDocumentWithPages } from '../../api/documents';
import { resolveMediaUrl, getErrorMessage } from '../../api/client';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import nb from '../../styles/notebook.module.css';
import styles from './DocumentPage.module.css';

/** One playbook: a page strip down the side, one page open in the main area.
 *
 * There is no page-selection step. Opening a page IS selecting it, and the
 * region-authoring tools land here in Milestone 3 (design doc §2.1).
 *
 * The full-resolution raster for a page does not exist until it is first
 * opened - so opening one can take a moment, and that wait is shown rather
 * than hidden. Every page after the first is instant, because the render is
 * kept.
 */
export function DocumentPage() {
  const { documentId } = useParams<{ documentId: string }>();
  const id = Number(documentId);

  const [document, setDocument] = useState<SourceDocumentWithPages | null>(null);
  const [openPage, setOpenPage] = useState<PageModel | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openPageNumber = useCallback(
    async (pageNumber: number) => {
      setIsRendering(true);
      setError(null);
      try {
        setOpenPage(await getDocumentPage(id, pageNumber));
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setIsRendering(false);
      }
    },
    [id],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await getDocument(id);
        if (cancelled) return;
        setDocument(loaded);
        // Land on page 1 rather than an empty frame: the coach came here to
        // look at the playbook, not to choose whether to start looking.
        if (loaded.pages.length > 0) void openPageNumber(loaded.pages[0].page_number);
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, openPageNumber]);

  if (document === null) {
    return error ? <ErrorBanner message={error} /> : <LoadingState label="Loading playbook" />;
  }

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={nb.heading}>{document.title}</h1>
          <p className={nb.subheading}>
            {document.page_count} {document.page_count === 1 ? 'page' : 'pages'}
          </p>
        </div>
        <Link to="/documents" className={nb.btnSecondary}>
          All playbooks
        </Link>
      </div>

      <ErrorBanner message={error} />

      <div className={styles.layout}>
        <nav className={styles.strip} aria-label="Pages">
          {document.pages.map((page) => (
            <button
              key={page.id}
              type="button"
              className={`${styles.thumb} ${
                openPage?.page_number === page.page_number ? styles.thumbActive : ''
              }`}
              aria-current={openPage?.page_number === page.page_number ? 'page' : undefined}
              onClick={() => openPageNumber(page.page_number)}
            >
              {page.thumbnail_url ? (
                <img
                  src={resolveMediaUrl(page.thumbnail_url)}
                  alt={`Page ${page.page_number}`}
                  // Reserved from the stored dimensions so the strip does not
                  // reflow as thumbnails load in.
                  style={{ aspectRatio: page.aspect_ratio ?? undefined }}
                />
              ) : (
                <span className={styles.thumbFallback} style={{ aspectRatio: page.aspect_ratio ?? undefined }} />
              )}
              <span className={styles.thumbLabel}>{page.page_number}</span>
            </button>
          ))}
        </nav>

        <div className={styles.viewer}>
          {isRendering && <LoadingState label="Rendering page" />}
          {!isRendering && openPage?.image_url && (
            <img
              className={styles.pageImage}
              src={resolveMediaUrl(openPage.image_url)}
              alt={`${document.title}, page ${openPage.page_number}`}
              width={openPage.render_width}
              height={openPage.render_height}
            />
          )}
        </div>
      </div>
    </div>
  );
}
