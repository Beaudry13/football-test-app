import { useEffect, useRef } from 'react';
import { PeiraLogo } from './brand/PeiraLogo';
import { Modal } from './ui/Modal';
import nb from '../styles/notebook.module.css';
import styles from './OnboardingModal.module.css';

interface OnboardingModalProps {
  onDismiss: () => void;
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** "What is Peira?" - explains the Greek meaning behind the name. Shown
 * automatically the first time a coach lands on a notebook-themed page
 * (see NotebookHeader, which owns the open/dismissed state and its
 * localStorage persistence) and re-openable anytime via the header link.
 * Composes components/ui/Modal for the portal/backdrop/panel shell - see
 * that file for why it portals to document.body. */
export function OnboardingModal({ onDismiss }: OnboardingModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Whatever had focus when the modal opened (the "What is Peira?" trigger,
    // when opened manually) - focus returns there once this unmounts.
    triggerRef.current = document.activeElement as HTMLElement | null;
    cardRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      // Wrap at both ends so Tab can never reach the page behind the modal.
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
      triggerRef.current?.focus();
    };
  }, [onDismiss]);

  return (
    <Modal ref={cardRef} onDismiss={onDismiss} labelledBy="onboarding-modal-title" size="md" showCloseButton>
      <div className={styles.mark}>
        <PeiraLogo variant="dark" markOnly size={40} />
      </div>
      <h2 id="onboarding-modal-title" className={styles.heading}>
        Welcome to Peira
      </h2>
      <p className={styles.body}>
        In Greek, <em className={styles.emphasis}>peîra</em> (πεῖρα) means{' '}
        <em className={styles.emphasis}>trial, test, proof through experience</em>.
      </p>
      <p className={styles.body}>
        Every quiz you send your team is a trial - a chance for them to prove what they know. This
        is your coach dashboard: build trials, send them to your roster, and track who rises to
        the challenge.
      </p>
      <button className={nb.btnPrimary} onClick={onDismiss}>
        Begin
      </button>
    </Modal>
  );
}
