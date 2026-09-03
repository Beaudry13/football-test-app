import { useState } from 'react';
import nb from '../styles/notebook.module.css';
import styles from './AnswerKeyDialog.module.css';
import { Modal } from './ui/Modal';
import { ErrorBanner } from './ErrorBanner';
import { exportAnswerKeyPdf } from '../api/quizzes';
import { downloadBlob } from '../utils/download';
import { getErrorMessage } from '../api/client';
import type { Quiz } from '../api/types';

/** Pick the tests, get one PDF of them and their correct answers.
 *
 * AN ANSWER KEY, NOT A RESULTS EXPORT. Nothing here asks for a player, a score
 * or an attempt, and the endpoint it calls cannot return one - a coach opening
 * this wants to read the test they wrote, and handing them their squad's
 * performance instead would be the wrong document.
 *
 * SELECTION LIVES HERE, not on QuizCard. The card is shared by the dashboard,
 * folders and Admin View, and threading a selection mode through all three to
 * serve one export would have put a checkbox in front of every coach on every
 * page for a feature most of them use occasionally.
 */
export function AnswerKeyDialog({
  quizzes,
  onClose,
}: {
  quizzes: Quiz[];
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: number) {
    setSelected((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }

  async function handleExport() {
    setError(null);
    setBusy(true);
    try {
      const blob = await exportAnswerKeyPdf(selected);
      const date = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `answer-key-${date}.pdf`);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onDismiss={onClose} ariaLabel="Export an answer key" showCloseButton>
      <div className={styles.panel}>
        <h2 className={nb.heading}>Answer key</h2>
        <p className={styles.hint}>
          One PDF of the tests you pick and their correct answers. Questions you
          have marked &ldquo;don&rsquo;t count&rdquo; are left out.
        </p>

        <ErrorBanner message={error} />

        {quizzes.length === 0 ? (
          <p className={styles.hint}>You have no quizzes yet.</p>
        ) : (
          <>
            <div className={styles.actions}>
              <button
                type="button"
                className={nb.btnSm}
                onClick={() => setSelected(quizzes.map((q) => q.id))}
              >
                Select all
              </button>
              <button
                type="button"
                className={nb.btnSm}
                onClick={() => setSelected([])}
                disabled={selected.length === 0}
              >
                Clear
              </button>
            </div>

            <ul className={styles.list}>
              {quizzes.map((quiz) => (
                <li key={quiz.id}>
                  <label className={styles.row}>
                    <input
                      type="checkbox"
                      checked={selected.includes(quiz.id)}
                      onChange={() => toggle(quiz.id)}
                    />
                    <span>{quiz.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={nb.btnPrimary}
            onClick={() => void handleExport()}
            disabled={busy || selected.length === 0}
          >
            {busy
              ? 'Building PDF…'
              : `Download answer key${selected.length ? ` (${selected.length})` : ''}`}
          </button>
          <button type="button" className={nb.btnSecondary} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
