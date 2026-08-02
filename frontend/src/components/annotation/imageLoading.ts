function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

export interface PrescaledImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** The source photo's real, uncapped resolution - lets a caller detect
   * when `capWidth` couldn't be reached because the photo itself is
   * smaller (see AnnotationViewer.tsx's renderScale computation). */
  naturalWidth: number;
}

/** Loads `url` and pre-renders it to its exact display size (capped at
 * `capWidth`) on a plain canvas, for handing to Fabric as a background
 * image. Fabric's own image-drawing path has a bug where a large source
 * image (e.g. a 2048x1152 or 1242x2208 photo) only renders a portion of
 * itself once scaled down - traced to its internal filter-scaling/crop
 * math, not to caching or CORS (both independently verified fine: a
 * manual drawImage() at the same target size always renders correctly,
 * regardless of source resolution). Handing Fabric an already-correctly-
 * sized source sidesteps that internal path entirely.
 *
 * crossOrigin: 'anonymous' is required once images can come from a
 * different origin (R2) - without it the browser taints the canvas the
 * moment we draw a cross-origin image onto it, so getContext('2d')
 * .drawImage() below would silently fail. The image host must send
 * matching CORS headers back (see R2 bucket CORS policy / backend CORS
 * config for local uploads).
 *
 * Shared by the coach's editable AnnotationCanvas and the read-only
 * AnnotationViewer players see - both need pixel-identical rendering of
 * the same saved shapes, so they share this loading step too. */
export async function loadPrescaledImage(url: string, capWidth: number): Promise<PrescaledImage> {
  const rawImage = await loadImageElement(url);
  const naturalWidth = rawImage.naturalWidth || capWidth;
  const naturalHeight = rawImage.naturalHeight || naturalWidth;
  const scale = Math.min(1, capWidth / naturalWidth);
  const width = Math.round(naturalWidth * scale);
  const height = Math.round(naturalHeight * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(rawImage, 0, 0, width, height);

  return { canvas, width, height, naturalWidth };
}
