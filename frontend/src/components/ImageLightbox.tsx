import { useEffect } from 'react';
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

export function ImageLightbox({ src, alt, onClose, annotations, canvasWidth = null }: ImageLightboxProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <Modal onDismiss={onClose} ariaLabel={alt} size="bare" showCloseButton closeLabel="Close">
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
