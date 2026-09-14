import { useCallback, useEffect, useRef } from 'react';
import type { IssuedPin } from '../../api/players';
import { useConfirmDialog } from '../ConfirmDialog';
import { Modal } from '../ui/Modal';
import nb from '../../styles/notebook.module.css';
import { formatPin } from './formatPin';
import styles from './PinSheetDialog.module.css';

const FOCUSABLE =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export const CLOSE_WARNING =
  "These PINs can't be shown again. Players who lose a PIN will need a new one.";

/** The one and only time a coach sees these PINs.
 *
 * THIS SHEET CONTAINS SECRETS, AND IT IS BUILT SO NOTHING ELSE DOES.
 * The PINs live in this component's props and nowhere else: not in storage,
 * not in a URL, not on the server (which only ever held their hashes). There
 * is no way to reopen it - closing it is final, which is why every way of
 * closing asks first.
 *
 * A football sheet, not an admin export: player, jersey, position, PIN, big
 * enough to read off a clipboard, and a Print button that prints only this.
 *
 * TWO JOHN SMITHS stay distinguishable the same way the roster table keeps
 * them apart - by their own # and Position columns, rather than by a suffix
 * that would repeat the columns beside it.
 */
export function PinSheetDialog({ pins, onClosed }: { pins: IssuedPin[]; onClosed: () => void }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const confirmingRef = useRef(false);
  const { confirm, dialog } = useConfirmDialog();

  const requestClose = useCallback(async () => {
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    try {
      const close = await confirm({
        title: 'Close this PIN sheet?',
        body: CLOSE_WARNING,
        confirmLabel: 'Close sheet',
        cancelLabel: 'Keep open',
      });
      if (close) onClosed();
    } finally {
      confirmingRef.current = false;
    }
  }, [confirm, onClosed]);

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    sheetRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      // While the "are you sure" dialog is up, it owns the keyboard.
      if (confirmingRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        void requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      triggerRef.current?.focus?.();
    };
  }, [requestClose]);

  const single = pins.length === 1 ? pins[0] : null;

  return (
    <>
      <Modal
        ref={sheetRef}
        onDismiss={() => void requestClose()}
        labelledBy="pin-sheet-title"
        size="md"
      >
        <div className={styles.sheet} data-pin-sheet>
          <h2 id="pin-sheet-title" className={styles.title}>
            {single ? `PIN for ${single.full_name}` : `Player PINs (${pins.length})`}
          </h2>
          <p className={styles.intro}>
            <strong>This is the only time these PINs are shown.</strong> Give each player their own
            PIN, and keep this sheet private.
          </p>

          <div className={styles.tableScroll}>
            <table className={`${nb.table} ${styles.table}`}>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>#</th>
                  <th>Pos</th>
                  <th>PIN</th>
                </tr>
              </thead>
              <tbody>
                {pins.map((entry) => (
                  <tr key={entry.player_id}>
                    <td>{entry.full_name}</td>
                    <td>{entry.jersey_number ? `#${entry.jersey_number}` : '—'}</td>
                    <td>{entry.position ?? '—'}</td>
                    <td className={styles.pin} aria-label={`PIN ${entry.pin.split('').join(' ')}`}>
                      {formatPin(entry.pin)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.actions} data-print-hide>
            <button type="button" className={nb.btnSm} onClick={() => window.print()}>
              Print
            </button>
            <button type="button" className={nb.btnPrimary} onClick={() => void requestClose()}>
              Done
            </button>
          </div>
        </div>
      </Modal>
      {dialog}
    </>
  );
}
