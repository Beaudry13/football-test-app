import { useEffect, useRef, type ReactNode } from 'react';
import { Modal } from '../components/ui/Modal';
import nb from '../styles/notebook.module.css';
import styles from './Help.module.css';

interface HelpArticleModalProps {
  title: string;
  children: ReactNode;
  onDismiss: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** The reading surface for any help article.
 *
 *  One modal for every topic, so a new article is content in the registry and
 *  nothing else. The focus trap, Escape handling and scroll lock are lifted
 *  from the old standalone "What is Peira?" modal - Modal itself is only the
 *  backdrop and panel, deliberately (see components/ui/Modal). */
export function HelpArticleModal({ title, children, onDismiss }: HelpArticleModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    // Whatever had focus when this opened - the Help menu item - gets it back
    // when the article closes, so the menu is still where the coach left it.
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
    <Modal
      ref={cardRef}
      onDismiss={onDismiss}
      labelledBy="help-article-title"
      size="md"
      showCloseButton
      // Distinct from the "Close" button at the foot of the article: two
      // controls sharing one accessible name is ambiguous to anyone not
      // looking at the screen.
      closeLabel="Close help"
    >
      <h2 id="help-article-title" className={styles.heading}>
        {title}
      </h2>
      <div className={styles.article}>{children}</div>
      <button className={nb.btnPrimary} onClick={onDismiss}>
        Close
      </button>
    </Modal>
  );
}
