import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from './ui/Modal';
import nb from '../styles/notebook.module.css';
import styles from './ConfirmDialog.module.css';

export interface ConfirmOptions {
  /** Short question, e.g. "Delete Quiz?" */
  title: string;
  /** What will happen, plainly. */
  body: ReactNode;
  /** Names the destructive act, e.g. "Delete Quiz" - never a bare "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Run while the dialog stays open and disabled, so a slow request can't be
   * fired twice by an impatient second click. Rejections propagate to the
   * caller of confirm() after the dialog closes. */
  action?: () => Promise<unknown>;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
  reject: (error: unknown) => void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Peira-styled replacement for window.confirm on destructive actions.
 *
 * Returns a `confirm()` that resolves true once the coach confirms (and any
 * `action` has finished) or false if they cancel, plus the `dialog` node to
 * render somewhere in the component.
 */
export function useConfirmDialog() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    // Whatever the coach clicked to get here - focus goes back to it on close
    // so keyboard and screen-reader users don't get dumped at the top of the page.
    triggerRef.current = document.activeElement as HTMLElement | null;
    return new Promise<boolean>((resolve, reject) => {
      setPending({ ...options, resolve, reject });
    });
  }, []);

  const close = useCallback(() => {
    setPending(null);
    setIsBusy(false);
    triggerRef.current?.focus();
    triggerRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    if (isBusy) return;
    pending?.resolve(false);
    close();
  }, [close, isBusy, pending]);

  const handleConfirm = useCallback(async () => {
    if (!pending || isBusy) return;
    if (!pending.action) {
      pending.resolve(true);
      close();
      return;
    }
    setIsBusy(true);
    try {
      await pending.action();
      pending.resolve(true);
    } catch (error) {
      pending.reject(error);
    } finally {
      close();
    }
  }, [close, isBusy, pending]);

  useEffect(() => {
    if (!pending) return;
    // Focus the destructive button's neighbour first: Cancel is the safe
    // default, so a stray Enter dismisses rather than deletes.
    dialogRef.current?.querySelector<HTMLElement>(`.${styles.cancelButton}`)?.focus();
  }, [pending]);

  useEffect(() => {
    if (!pending) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleCancel();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      // Wrap at both ends so Tab can never reach the page behind the dialog.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [handleCancel, pending]);

  const dialog = pending ? (
    <Modal
      ref={dialogRef}
      onDismiss={handleCancel}
      role="alertdialog"
      labelledBy="confirm-dialog-title"
      describedBy="confirm-dialog-body"
    >
      <h2 id="confirm-dialog-title" className={styles.title}>
        {pending.title}
      </h2>
      <div id="confirm-dialog-body" className={styles.body}>
        {pending.body}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={`${nb.btnSm} ${styles.cancelButton}`}
          onClick={handleCancel}
          disabled={isBusy}
        >
          {pending.cancelLabel ?? 'Cancel'}
        </button>
        <button
          type="button"
          className={`${nb.btnSm} ${nb.btnDanger} ${styles.confirmButton}`}
          onClick={handleConfirm}
          disabled={isBusy}
        >
          {isBusy ? 'Working…' : pending.confirmLabel}
        </button>
      </div>
    </Modal>
  ) : null;

  return { confirm, dialog };
}
