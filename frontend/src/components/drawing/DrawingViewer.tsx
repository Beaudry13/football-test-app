import { useEffect, useRef, useState } from 'react';
import { FabricImage, Polyline, StaticCanvas } from 'fabric';
import { validateDocument } from './drawingDocument';
import type { DrawingDocument, DrawingStroke } from './types';
import styles from './DrawingViewer.module.css';

/** Read-only render of a submitted drawing, for the coach.
 *
 * Renders from the stored strokes rather than a flattened image. That is a
 * deliberate Phase 3 choice: it keeps object storage, server-side rendering
 * and a second copy of the truth out of this phase entirely. The flattened
 * preview arrives in Phase 6, when the PDF export genuinely needs a raster -
 * and even then the strokes stay the source of truth.
 *
 * StaticCanvas, not the editing engine: nothing here needs pointer handling,
 * a brush, or the gesture arbiter, and mounting the full engine to show a
 * picture would drag all of it into the coach bundle.
 *
 * The strokes are drawn as polylines rather than replayed through PencilBrush.
 * The brush requires an interactive Canvas, and at the density the board
 * records points (decimate 0.2) the visible difference between a polyline and
 * the brush's smoothed quadratic path is negligible. If that ever stops being
 * true, this is the one place to change.
 */
export function DrawingViewer({
  imageUrl,
  document,
  maxWidth = 720,
  alt,
}: {
  imageUrl: string;
  document: DrawingDocument;
  maxWidth?: number;
  alt: string;
}) {
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = canvasElRef.current;
    if (!element) return;

    // Refuse a document this client cannot read rather than rendering half of
    // it. A coach seeing a partial drawing and grading it would be worse than
    // a coach seeing an honest error.
    const problems = validateDocument(document);
    if (problems.length > 0) {
      setError('This drawing could not be displayed.');
      return;
    }

    const scale = Math.min(1, maxWidth / document.coordinate_width);
    const canvas = new StaticCanvas(element, {
      width: document.coordinate_width * scale,
      height: document.coordinate_height * scale,
      backgroundColor: '#0b0d0f',
      enableRetinaScaling: false,
    });
    // One transform for the whole scene: the strokes stay in the coordinate
    // space they were authored in, exactly as on the player's board, and only
    // the view is scaled. Baking the scale into each stroke's points instead
    // would be the classic way to make a re-render drift from the original.
    canvas.setViewportTransform([scale, 0, 0, scale, 0, 0]);

    let cancelled = false;

    async function draw() {
      try {
        const image = await FabricImage.fromURL(imageUrl, { crossOrigin: 'anonymous' });
        if (cancelled) return;

        const naturalWidth = image.width ?? document.coordinate_width;
        const imageScale = document.coordinate_width / naturalWidth;
        // SAME ORIGIN RULE AS THE PLAYER'S BOARD, and it has to be, because
        // this renders the same document. Fabric hands back an image whose
        // origin is its CENTRE, so `left: 0, top: 0` put the middle of the
        // picture at scene (0,0) and only its bottom-right quadrant fell
        // inside a canvas that starts there - while the strokes, which carry
        // absolute coordinate-space points, sat exactly where the player drew
        // them. The coach therefore saw the right marks over the wrong part of
        // the picture, which is worse than either being wrong alone.
        image.set({
          originX: 'left',
          originY: 'top',
          left: 0,
          top: 0,
          scaleX: imageScale,
          scaleY: imageScale,
          selectable: false,
        });
        canvas.add(image);

        // Ordered explicitly rather than trusting array order, so a document
        // that was merged or re-saved still stacks the way the player drew it.
        const ordered = [...document.strokes].sort((a, b) => a.order - b.order);
        for (const stroke of ordered) canvas.add(toPolyline(stroke));

        canvas.renderAll();
      } catch {
        if (!cancelled) setError('Could not load the image this drawing was made on.');
      }
    }

    void draw();

    return () => {
      cancelled = true;
      void canvas.dispose();
    };
  }, [imageUrl, document, maxWidth]);

  if (error) return <div className={styles.error}>{error}</div>;

  return (
    <div className={styles.wrapper}>
      <canvas ref={canvasElRef} className={styles.canvas} aria-label={alt} role="img" />
    </div>
  );
}

function toPolyline(stroke: DrawingStroke): Polyline {
  const points = [];
  for (let i = 0; i < stroke.points.length; i += 2) {
    points.push({ x: stroke.points[i], y: stroke.points[i + 1] });
  }
  return new Polyline(points, {
    stroke: stroke.color,
    strokeWidth: stroke.width,
    opacity: stroke.opacity ?? 1,
    fill: undefined,
    // Round caps and joins match what the brush produces, and stop a fast
    // stroke's direction changes reading as sharp corners.
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    selectable: false,
    evented: false,
    // Fabric scales strokeWidth with the object by default, which would make
    // the line thicken as the viewer scales down. The stroke width is in
    // coordinate-space units and must scale WITH the scene, so this stays on -
    // it is the object transform, not the viewport, that must not distort it.
    objectCaching: false,
  });
}
