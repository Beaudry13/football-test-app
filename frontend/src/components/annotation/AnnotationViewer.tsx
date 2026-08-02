import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { FabricImage, StaticCanvas } from 'fabric';
import type { AnnotationLayer } from '../../api/types';
import { PLAYER_RENDER_SCALE, resolveCanvasWidth } from './canvasSizing';
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
        // capWidth is the coordinate space every saved annotation's x/y is relative to - it
        // must never change for an already-annotated image. The prescale target below is
        // deliberately bigger (PLAYER_RENDER_SCALE), so players get real extra pixel detail to
        // pinch-zoom into; renderScale (computed from what was actually returned, not what was
        // requested - loadPrescaledImage never upscales past the source's own resolution) is
        // the factor that brings the image back into alignment with capWidth-space shapes.
        const capWidth = resolveCanvasWidth(canvasWidth, annotations.length > 0);
        const targetWidth = capWidth * PLAYER_RENDER_SCALE;
        const { canvas: prescaled, width, height } = await loadPrescaledImage(imageUrl, targetWidth);
        if (cancelled || !canvasElRef.current) return;
        const renderScale = width / capWidth;

        // enableRetinaScaling is disabled so the backing store size is driven entirely by our
        // own renderScale math, not additionally multiplied by devicePixelRatio (which could
        // otherwise compound into an unpredictably huge canvas on high-DPR phones).
        const canvas = new StaticCanvas(canvasElRef.current, { enableRetinaScaling: false });
        staticCanvas = canvas;
        canvas.setDimensions({ width, height }, { backstoreOnly: true });
        // Deliberately imperative, not left to the `style` prop below: the StaticCanvas
        // constructor itself already did its own CSS sizing (defaulting to the bare <canvas>
        // element's 300x150 HTML-spec size) before this line ever runs. Since the `style` prop's
        // width/height values don't change across the isReady flip, React's own style diffing
        // skips re-applying them on the second render, so it never actually overwrites Fabric's
        // constructor-time mutation - only an explicit, synchronous imperative call here does.
        canvas.setDimensions({ width: '100%', height: 'auto' }, { cssOnly: true });

        const image = new FabricImage(prescaled);
        image.set({
          selectable: false,
          evented: false,
          originX: 'left',
          originY: 'top',
          // Cancels out canvas.setZoom(renderScale) below, so the image itself lands at its
          // full native prescaled pixel size on the backing store (no double- or under-scale).
          scaleX: 1 / renderScale,
          scaleY: 1 / renderScale,
        });
        canvas.backgroundImage = image;

        if (annotations.length > 0) {
          // Same reasoning as AnnotationCanvas: loadFromJSON replaces the
          // whole canvas state, clearing the backgroundImage just set above.
          await canvas.loadFromJSON({ objects: annotations });
          if (cancelled) return;
          canvas.backgroundImage = image;
        }

        // Scales the whole scene (image + annotation shapes, both still authored/anchored in
        // capWidth-space) up together onto the bigger backing store, keeping them aligned.
        canvas.setZoom(renderScale);
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
      style={{
        // Baseline CSS size: StaticCanvas's own constructor unconditionally sizes the element
        // to the bare <canvas>'s HTML-spec default (300x150) as an inline style before setup()
        // ever runs, and setDimensions({backstoreOnly:true}) above deliberately never corrects
        // that - so without an explicit baseline here, a consumer that doesn't pass its own
        // width/height in `style` (e.g. ImageLightbox) would be stuck at 300x150. A caller's
        // own `style` still wins where it sets these same keys, since it's spread after.
        width: '100%',
        height: 'auto',
        ...style,
        display: isReady ? (style?.display ?? 'block') : 'none',
      }}
    />
  );
}
