import { useEffect, useState } from 'react';
import { getDocument, getDocumentPage, listDocuments } from '../../api/documents';
import type { DocumentPage, SourceDocument } from '../../api/documents';
import { getErrorMessage, resolveMediaUrl } from '../../api/client';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import nb from '../../styles/notebook.module.css';
import styles from './PlaybookPicker.module.css';

/** Pick a page out of a playbook, in the space the image control already
 *  occupies.
 *
 *  NOT A SCREEN AND NOT A MODAL. It renders inside the question editor's
 *  existing "Image (optional)" area and hands the page straight back, because
 *  the coach is in the middle of writing a question - sending them into a
 *  playbook-management interface and expecting them to find their way back is
 *  the workflow this whole redesign exists to remove.
 *
 *  Two steps, both lists of pictures: which playbook, then which page. There is
 *  no third step - what the coach does with the page happens back in the editor
 *  where they can see it beside their question.
 */
export function PlaybookPicker({
  onPicked,
  onCancel,
}: {
  onPicked: (choice: { page: DocumentPage; documentTitle: string }) => void;
  onCancel: () => void;
}) {
  const [playbooks, setPlaybooks] = useState<SourceDocument[] | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [pages, setPages] = useState<DocumentPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listDocuments()
      .then((found) => {
        setPlaybooks(found);
        // ONE PLAYBOOK IS THE COMMON CASE, and asking a coach to choose from a
        // list of one is a step that buys nothing. Open it straight away.
        if (found.length === 1) void open(found[0].id);
      })
      .catch((err) => setError(getErrorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function open(documentId: number) {
    setError(null);
    setOpenId(documentId);
    setPages(null);
    try {
      setPages((await getDocument(documentId)).pages);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function choose(page: DocumentPage) {
    // The thumbnail in the strip is not big enough to use as a question's
    // picture, so the full render is fetched here - which is also what makes
    // the page appear immediately in the editor rather than after a save.
    setBusy(true);
    setError(null);
    try {
      const full = await getDocumentPage(openId!, page.page_number);
      const title = playbooks?.find((p) => p.id === openId)?.title ?? '';
      onPicked({ page: full, documentTitle: title });
    } catch (err) {
      setError(getErrorMessage(err));
      setBusy(false);
    }
  }

  const openPlaybook = playbooks?.find((p) => p.id === openId) ?? null;

  return (
    <div className={styles.picker}>
      <div className={styles.head}>
        <span className={styles.title}>
          {openPlaybook ? openPlaybook.title : 'Choose a playbook'}
        </span>
        <button type="button" className={nb.btnSm} onClick={onCancel}>
          Cancel
        </button>
      </div>

      <ErrorBanner message={error} />

      {playbooks === null && <LoadingState label="Loading playbooks" />}

      {playbooks !== null && playbooks.length === 0 && (
        <p className={styles.empty}>
          No playbooks yet. Upload one from Playbooks and it will appear here.
        </p>
      )}

      {openId === null &&
        playbooks !== null &&
        playbooks.length > 0 && (
          <ul className={styles.list}>
            {playbooks.map((playbook) => (
              <li key={playbook.id}>
                <button
                  type="button"
                  className={styles.listItem}
                  onClick={() => void open(playbook.id)}
                >
                  <span className={styles.listTitle}>{playbook.title}</span>
                  <span className={styles.listMeta}>
                    {playbook.page_count} {playbook.page_count === 1 ? 'page' : 'pages'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

      {openId !== null && pages === null && <LoadingState label="Loading pages" />}

      {openId !== null && pages !== null && (
        <>
          {playbooks !== null && playbooks.length > 1 && (
            <button
              type="button"
              className={styles.back}
              onClick={() => {
                setOpenId(null);
                setPages(null);
              }}
            >
              ← All playbooks
            </button>
          )}
          <ul className={styles.pages}>
            {pages.map((page) => (
              <li key={page.id}>
                <button
                  type="button"
                  className={styles.page}
                  disabled={busy}
                  onClick={() => void choose(page)}
                  aria-label={`Use page ${page.page_number}`}
                >
                  {page.thumbnail_url ? (
                    <img
                      src={resolveMediaUrl(page.thumbnail_url)}
                      alt=""
                      style={{ aspectRatio: page.aspect_ratio ?? undefined }}
                    />
                  ) : (
                    <span
                      className={styles.blank}
                      style={{ aspectRatio: page.aspect_ratio ?? undefined }}
                    />
                  )}
                  <span className={styles.pageNumber}>{page.page_number}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
