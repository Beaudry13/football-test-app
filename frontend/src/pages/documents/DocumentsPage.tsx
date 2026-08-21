import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { deleteDocument, listDocuments, uploadDocument } from '../../api/documents';
import type { SourceDocument } from '../../api/documents';
import { getErrorMessage } from '../../api/client';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { LoadingState } from '../../components/ui/LoadingState';
import { EmptyState } from '../../components/ui/EmptyState';
import nb from '../../styles/notebook.module.css';
import styles from './DocumentsPage.module.css';
import { MenuButton, MenuItem } from '../../components/ui/MenuButton';

function formatSize(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return megabytes < 0.1 ? '<0.1 MB' : `${megabytes.toFixed(1)} MB`;
}

/** The coach's uploaded playbooks. Upload goes straight into the document, so
 *  there is no "now pick your pages" step to enter and exit - a page is chosen
 *  by being worked on (design doc §2.1). */
export function DocumentsPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState<SourceDocument[] | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, dialog } = useConfirmDialog();

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    try {
      setDocuments(await listDocuments());
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setIsUploading(true);
    setError(null);
    try {
      const created = await uploadDocument(file);
      // Straight into the document. Uploading it was never the goal.
      navigate(`/documents/${created.id}`);
    } catch (err) {
      setError(getErrorMessage(err));
      setIsUploading(false);
    } finally {
      // Clearing the input matters: without it, re-picking the same file
      // after a failed upload fires no change event at all.
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleDelete(document: SourceDocument) {
    setError(null);
    try {
      await confirm({
        title: 'Delete playbook?',
        // Does not promise success. The API refuses to delete a playbook any
        // quiz question was built from, and names those quizzes - but the
        // list payload carries no usage signal, so the button cannot know in
        // advance. Better to say the condition than to assert an outcome and
        // then fail.
        body:
          `"${document.title}" and its rendered pages will be permanently removed. ` +
          `A playbook that a quiz question was built from cannot be deleted.`,
        confirmLabel: 'Delete Playbook',
        action: async () => {
          await deleteDocument(document.id);
          await refresh();
        },
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  return (
    <div>
      {dialog}
      <div className={styles.header}>
        <h1 className={nb.heading}>Playbooks</h1>
        <div>
          <input
            ref={fileInputRef}
            id="playbook-upload"
            type="file"
            accept="application/pdf,.pdf"
            className={nb.srOnly}
            disabled={isUploading}
            onChange={(event) => handleFile(event.target.files?.[0])}
          />
          <label htmlFor="playbook-upload" className={nb.btnPrimary}>
            {isUploading ? 'Uploading…' : 'Upload PDF'}
          </label>
        </div>
      </div>

      <p className={nb.subheading}>
        Upload a playbook PDF to build quiz questions from its pages. Playbooks are private to
        your program and are never shared by link.
      </p>

      <ErrorBanner message={error} />

      {documents === null ? (
        <LoadingState label="Loading playbooks" />
      ) : documents.length === 0 ? (
        <EmptyState message="Upload a PDF and its pages appear here, ready to build questions from." />
      ) : (
        <ul className={styles.list}>
          {documents.map((document) => (
            <li key={document.id} className={`${nb.card} ${styles.row}`}>
              <Link to={`/documents/${document.id}`} className={styles.rowLink}>
                <span className={styles.rowTitle}>{document.title}</span>
                <span className={styles.rowMeta}>
                  {document.page_count} {document.page_count === 1 ? 'page' : 'pages'} ·{' '}
                  {formatSize(document.byte_size)}
                </span>
              </Link>
              {/* OPENING IS PRIMARY; DELETING IS MAINTENANCE.
                  Delete was a permanent red button 13px from the link that
                  opens the playbook - the highest-contrast thing on the row,
                  beside the one action a coach actually came for, and an easy
                  mis-tap on a phone. Quiz cards and folder rows already put
                  this kind of action behind the same one control.
                  The confirmation, its wording and the API are untouched. */}
              <MenuButton label={`Options for ${document.title}`}>
                <MenuItem destructive onSelect={() => handleDelete(document)}>
                  Delete playbook
                </MenuItem>
              </MenuButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
