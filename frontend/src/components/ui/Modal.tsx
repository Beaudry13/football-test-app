import { forwardRef, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
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
 * shared by ConfirmDialog/OnboardingModal/ImageLightbox's chrome instead
 * of each hand-rolling its own backdrop/panel CSS. Deliberately just the
 * shell - focus-trap and Escape-key handling stay in each caller (they
 * already have working, tested implementations; duplicating that logic
 * here would be riskier to get right than the small CSS duplication it
 * used to replace).
 *
 * Rendered through a portal to document.body so it always paints above
 * everything, regardless of where in the DOM the caller lives (mirrors
 * OnboardingModal's original reasoning: NotebookHeader's own stacking
 * context would otherwise sit under `.content`). */
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

  const backdropClass = size === 'bare' ? `${styles.backdrop} ${styles.backdropBare}` : styles.backdrop;
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
