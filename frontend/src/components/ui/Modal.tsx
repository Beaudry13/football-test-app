import { forwardRef, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import nb from '../../styles/notebook.module.css';
import styles from './Modal.module.css';

interface ModalProps {
  children: ReactNode;
  /** Backdrop click (or the optional close button) calls this - the
   * caller owns whether/how the modal actually closes (e.g. ConfirmDialog
   * ignores it while a confirm action is in flight). */
  onDismiss: () => void;
  role?: 'dialog' | 'alertdialog';
  /** id of an element inside the panel to use as its accessible name.
   * Provide this OR `ariaLabel` (e.g. the image lightbox has no heading
   * to point at, so it passes the image's alt text as `ariaLabel`
   * instead). */
  labelledBy?: string;
  ariaLabel?: string;
  describedBy?: string;
  /** sm (420px, default) for confirm-style dialogs; md (460px, centered
   * text) for the onboarding/"what is Peira" style; bare (no card chrome
   * at all, fullscreen scrim) for the image lightbox. */
  size?: 'sm' | 'md' | 'bare';
  showCloseButton?: boolean;
  closeLabel?: string;
}

/** Token-driven modal shell (backdrop + panel + optional close button),
 * shared by ConfirmDialog/HelpArticleModal/ImageLightbox's chrome instead
 * of each hand-rolling its own backdrop/panel CSS. Deliberately just the
 * shell - focus-trap and Escape-key handling stay in each caller (they
 * already have working, tested implementations; duplicating that logic
 * here would be riskier to get right than the small CSS duplication it
 * used to replace).
 *
 * Rendered through a portal to document.body so it always paints above
 * everything, regardless of where in the DOM the caller lives (the original
 * reasoning came from the header's onboarding modal: NotebookHeader's own
 * stacking context would otherwise sit under `.content`). */
export const Modal = forwardRef<HTMLDivElement, ModalProps>(function Modal(
  {
    children,
    onDismiss,
    role = 'dialog',
    labelledBy,
    ariaLabel,
    describedBy,
    size = 'sm',
    showCloseButton = false,
    closeLabel = 'Close',
  },
  ref,
) {
  function handlePanelMouseDown(event: MouseEvent) {
    event.stopPropagation();
  }

  /* THE BACKDROP CARRIES THE COACH TOKEN SCOPE, and a modal is broken without
     it. createPortal moves this subtree to document.body, so it has no .page
     ancestor - and every --nb-* name is declared on .page. Children that style
     themselves with those names (HelpArticleModal uses Help.module.css and
     nb.btnPrimary) therefore resolved NONE of them and fell through to the
     hardcoded light-theme fallbacks baked into those rules.

     Measured before this line existed, on the dark ground: the help article's
     heading rendered #2A2416 on #1E1B15 at 1.11 : 1 and its Close button lost
     its gold fill entirely and drew #14120E text at 1.09 : 1. Both invisible.

     The bug predates the dark theme - the names never resolved here - but the
     light fallbacks happened to sit on a light panel, so it never showed. */
  const backdropClass = size === 'bare'
    ? `${nb.coachTokens} ${styles.backdrop} ${styles.backdropBare}`
    : `${nb.coachTokens} ${styles.backdrop}`;
  const panelClass =
    size === 'md' ? `${styles.panel} ${styles.panelMd}` : size === 'bare' ? `${styles.panel} ${styles.panelBare}` : styles.panel;

  return createPortal(
    <div className={backdropClass} onMouseDown={onDismiss}>
      <div
        ref={ref}
        className={panelClass}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        onMouseDown={handlePanelMouseDown}
      >
        {showCloseButton && (
          <button type="button" className={styles.closeButton} onClick={onDismiss} aria-label={closeLabel}>
            <Icon name="close" size={14} />
          </button>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
});
