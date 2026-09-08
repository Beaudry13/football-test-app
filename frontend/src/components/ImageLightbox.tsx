import { useEffect, useRef } from 'react';
import type { AnnotationLayer } from '../api/types';
import { AnnotationViewer } from './annotation/AnnotationViewer';
import { PinchZoomPan } from './PinchZoomPan';
import { Modal } from './ui/Modal';
import styles from './ImageLightbox.module.css';

interface ImageLightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
  /** When present (and non-empty), the zoomed view renders the coach's
   * drawn routes/circles/callouts on top of the image instead of the bare
   * photo - the whole point of zooming in is usually to see them clearly. */
  annotations?: AnnotationLayer[];
  canvasWidth?: number | null;
}

/** Everything the browser will let a keyboard reach. Same list `ConfirmDialog`
 * traps against - kept in step with it deliberately rather than shared, since
 * the two dialogs have different shapes and a shared constant would invite a
 * change made for one to silently alter the other. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function ImageLightbox({ src, alt, onClose, annotations, canvasWidth = null }: ImageLightboxProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  /* WHATEVER OPENED THIS, so closing can hand focus back to it. Captured on
     mount rather than passed in, because the openers are in three different
     files and none of them should have to plumb a ref through to get standard
     dialog behaviour. */
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    // The close button is the only control in here, so it is also the only
    // sensible landing place - and starting on it means Escape is not the
    // sole keyboard way out.
    panelRef.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      // Optional-chained on purpose: the player's opener is a plain <img>,
      // which is not focusable, and a coach can close this after the row it
      // came from has been re-rendered away.
      triggerRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      /* TAB MUST NOT REACH THE PAGE BEHIND. `aria-modal` tells a screen
         reader the rest of the page is inert; it does nothing whatsoever to
         the tab order, so without this a coach tabbing out of the viewer
         lands on the question list they cannot see. */
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
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
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <Modal ref={panelRef} onDismiss={onClose} ariaLabel={alt} size="bare" showCloseButton closeLabel="Close">
      <PinchZoomPan>
        {annotations && annotations.length > 0 ? (
          <AnnotationViewer
            imageUrl={src}
            annotations={annotations}
            canvasWidth={canvasWidth}
            alt={alt}
            className={styles.image}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <img className={styles.image} src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
        )}
      </PinchZoomPan>
    </Modal>
  );
}
