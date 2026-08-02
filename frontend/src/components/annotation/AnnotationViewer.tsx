import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { FabricImage, StaticCanvas } from 'fabric';
import type { AnnotationLayer } from '../../api/types';
import { resolveCanvasWidth } from './canvasSizing';
import { loadPrescaledImage } from './imageLoading';

interface AnnotationViewerProps {
  imageUrl: string;
  annotations: AnnotationLayer[];
  /** `QuestionImage.canvas_width` - the coordinate space `annotations` was
   * authored in. Must be resolved the same way the editor resolves it
   * (see resolveCanvasWidth) or shapes land in the wrong place. */
  canvasWidth: number | null;
  alt: string;
  onClick?: (event: ReactMouseEvent<HTMLCanvasElement>) => void;
  className?: string;
  style?: CSSProperties;
}

/** Read-only counterpart to AnnotationCanvas: renders a question image with
 * its coach-drawn routes/circles/callouts composited on top, for players
 * (and quiz preview, which reuses this same component's consumer) rather
 * than for editing. No toolbar, no selection, no interaction - just the
 * same shapes drawn via the same Fabric objects, on a StaticCanvas instead
 * of an interactive one. */
export function AnnotationViewer({
  imageUrl,
  annotations,
  canvasWidth,
  alt,
  onClick,
  className,
  style,
}: AnnotationViewerProps) {
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!canvasElRef.current) return;
    let cancelled = false;
    let staticCanvas: StaticCanvas | null = null;

    async function setup() {
      try {
        const capWidth = resolveCanvasWidth(canvasWidth, annotations.length > 0);
        const { canvas: prescaled, width, height } = await loadPrescaledImage(imageUrl, capWidth);
        if (cancelled || !canvasElRef.current) return;

        const canvas = new StaticCanvas(canvasElRef.current);
        staticCanvas = canvas;
        canvas.setDimensions({ width, height });

        const image = new FabricImage(prescaled);
        image.set({ selectable: false, evented: false, originX: 'left', originY: 'top' });
        canvas.backgroundImage = image;

        if (annotations.length > 0) {
          // Same reasoning as AnnotationCanvas: loadFromJSON replaces the
          // whole canvas state, clearing the backgroundImage just set above.
          await canvas.loadFromJSON({ objects: annotations });
          if (cancelled) return;
          canvas.backgroundImage = image;
        }

        canvas.renderAll();
        setIsReady(true);
      } catch {
        if (!cancelled) setLoadError('Could not load this image.');
      }
    }

    setup();

    return () => {
      cancelled = true;
      staticCanvas?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl]);

  if (loadError) {
    return <div className="error-banner">{loadError}</div>;
  }

  return (
    <canvas
      ref={canvasElRef}
      role="img"
      aria-label={alt}
      onClick={onClick}
      className={className}
      style={{ ...style, display: isReady ? (style?.display ?? 'block') : 'none' }}
    />
  );
}
