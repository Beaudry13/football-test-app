/** The Fabric layer of the drawing board.
 *
 * Everything that must touch Fabric lives here; everything that can avoid it
 * (arbitration, document shape, render scale) lives in its own pure module.
 * That split is what makes the hard logic testable in jsdom, where Fabric's
 * canvas cannot run.
 *
 * DRIVING THE BRUSH BY HAND
 * -------------------------
 * `canvas.isDrawingMode = true` is deliberately NOT used. Fabric's built-in
 * free-drawing binds the brush directly to pointer events, which means the
 * stroke starts the instant a finger lands - exactly the behavior the grace
 * window exists to prevent. Instead the brush is driven manually through its
 * public API, so the arbiter decides when (and whether) a stroke begins.
 *
 * Verified against the installed fabric 7.4.0 type definitions:
 *   PencilBrush#onMouseDown(pointer: Point, { e }: TEvent): void
 *   PencilBrush#onMouseMove(pointer: Point, { e }: TEvent): void
 *   PencilBrush#onMouseUp({ e }: TEvent): boolean
 *   Canvas#getScenePoint(e: TPointerEvent): Point
 *   Canvas#zoomToPoint(point: Point, value: number): void
 *   Canvas#relativePan(point: Point): void
 *   Canvas#setViewportTransform(vpt: TMat2D): void
 *
 * `canvas.getPointer()` is deprecated in 7.x in favour of getScenePoint /
 * getViewportPoint and is not used here.
 */

import { Canvas, FabricImage, PencilBrush, Point, type FabricObject, type TMat2D } from 'fabric';
import { addStroke, createStrokeId, removeStroke } from './drawingDocument';
import { fitScale, type RenderScaleResult } from './renderScale';
import {
  PLAYER_STROKE_COLOR,
  PLAYER_STROKE_WIDTH,
  type DrawingDocument,
  type DrawingStroke,
} from './types';

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 8;

/** Marks a Fabric object as belonging to a DrawingDocument stroke, so the
 * eraser and serializer can find it again. Fabric allows arbitrary props on
 * objects; the annotation editor uses the same technique (see
 * annotation/types.ts ANNOTATION_PROPS). */
interface StrokeObject extends FabricObject {
  peiraStrokeId?: string;
}

export interface EngineCallbacks {
  onDocumentChange(document: DrawingDocument): void;
  /** Fired whenever the viewport transform changes, for the HUD's zoom readout. */
  onZoomChange?(zoom: number): void;
}

export class DrawingEngine {
  readonly canvas: Canvas;
  private brush: PencilBrush;
  private document: DrawingDocument;
  private callbacks: EngineCallbacks;
  private baseImage: FabricImage | null = null;
  /** Points accumulated for the stroke currently being drawn, in coordinate
   * space. Fabric's finalized Path is a smoothed curve, so the raw samples
   * are kept separately - they, not the smoothing, are the source of truth. */
  private activePoints: number[] = [];
  private drawing = false;
  /** Backing-store pixels per CSS pixel. Every pointer coordinate arrives in
   * CSS pixels and has to cross this boundary before it means anything to
   * Fabric, whose viewportTransform lives in backing-store space. */
  private renderScale = 1;
  /** Zoom at the moment the current pinch started. See beginPinch. */
  private pinchBaseZoom = 1;

  constructor(canvasElement: HTMLCanvasElement, document: DrawingDocument, callbacks: EngineCallbacks) {
    this.document = document;
    this.callbacks = callbacks;

    this.canvas = new Canvas(canvasElement, {
      // Selection and object interaction are off entirely: the only pointer
      // consumer is the arbiter, and Fabric's own hit-testing would otherwise
      // compete with it for the same touches.
      selection: false,
      renderOnAddRemove: false,
      preserveObjectStacking: true,
      enableRetinaScaling: false,
      backgroundColor: 'transparent',
    });

    this.brush = new PencilBrush(this.canvas);
    this.brush.color = PLAYER_STROKE_COLOR;
    this.brush.width = PLAYER_STROKE_WIDTH;
    // Fabric's default decimation drops points closer than 0.4px apart. At
    // high zoom that discards real detail from a slow, careful stroke, which
    // is precisely the stroke a coach cares about ("draw your run fit").
    this.brush.decimate = 0.2;
    this.canvas.freeDrawingBrush = this.brush;
  }

  getDocument(): DrawingDocument {
    return this.document;
  }

  getZoom(): number {
    return this.canvas.getZoom();
  }

  /** Loads the source image as a locked backdrop sized to the document's
   * coordinate space. The image is NOT a Fabric background so that it
   * participates in viewportTransform like everything else - a background
   * image would not zoom with the strokes. */
  async setSourceImage(url: string): Promise<void> {
    const image = await FabricImage.fromURL(url, { crossOrigin: 'anonymous' });
    const naturalWidth = image.width ?? this.document.coordinate_width;
    const scale = this.document.coordinate_width / naturalWidth;

    image.set({
      left: 0,
      top: 0,
      scaleX: scale,
      scaleY: scale,
      selectable: false,
      evented: false,
      hoverCursor: 'default',
    });

    if (this.baseImage) this.canvas.remove(this.baseImage);
    this.baseImage = image;
    this.canvas.add(image);
    this.canvas.sendObjectToBack(image);
    this.canvas.requestRenderAll();
  }

  /** Sizes the canvas as a WINDOW onto the scene.
   *
   * The backing store is the on-screen box times the render scale, so the
   * CSS-to-backing ratio is the same on both axes and nothing is stretched.
   * The image's own dimensions never enter into it - the image is positioned
   * inside the scene by the viewport transform, exactly like the strokes.
   *
   * Getting this wrong is subtle and was the first real bug this spike found:
   * sizing the backing store from the coordinate space instead makes
   * resetView's fit calculation collapse to the render scale, and squashes
   * the image to the overlay's aspect ratio. */
  resize(render: RenderScaleResult, cssWidth: number, cssHeight: number): void {
    const { backingWidth, backingHeight } = render;
    // Taken from the resolver rather than derived as backingWidth/cssWidth:
    // the backing dimensions are rounded to whole pixels independently, so
    // the two axes' derived ratios differ slightly, and a single scalar taken
    // from the width would skew y by that difference.
    this.renderScale = render.scale;
    this.canvas.setDimensions({ width: backingWidth, height: backingHeight });
    this.canvas.setDimensions({ width: `${cssWidth}px`, height: `${cssHeight}px` }, { cssOnly: true });
    this.canvas.requestRenderAll();
  }

  /** Fits the whole image in view. Used on open, on Reset View, and after an
   * orientation change - all of which change the viewport but must never
   * change the coordinate space. */
  resetView(): void {
    const zoom = fitScale(
      this.document.coordinate_width,
      this.document.coordinate_height,
      this.canvas.getWidth(),
      this.canvas.getHeight(),
    );
    const offsetX = (this.canvas.getWidth() - this.document.coordinate_width * zoom) / 2;
    const offsetY = (this.canvas.getHeight() - this.document.coordinate_height * zoom) / 2;
    this.canvas.setViewportTransform([zoom, 0, 0, zoom, offsetX, offsetY] as TMat2D);
    this.canvas.requestRenderAll();
    this.callbacks.onZoomChange?.(zoom);
  }

  /** Scene units per CSS pixel, i.e. the zoom the player actually perceives.
   * Fabric's own getZoom() is per backing-store pixel, so it changes when the
   * render scale changes even though nothing looks different. */
  getCssZoom(): number {
    return this.canvas.getZoom() / this.renderScale;
  }

  /** The scene point currently at the middle of the board. */
  getSceneCenter(): Point {
    return this.toScene(
      this.canvas.getWidth() / (2 * this.renderScale),
      this.canvas.getHeight() / (2 * this.renderScale),
    );
  }

  /** Restores a view by what the player was looking at rather than by raw
   * transform values. Used across a resize: the backing store and render
   * scale may both have changed, and replaying the old transform verbatim
   * would shift the image under the player's finger. */
  centerOn(scene: Point, cssZoom: number): void {
    const zoom = clamp(cssZoom, MIN_ZOOM, MAX_ZOOM) * this.renderScale;
    const offsetX = this.canvas.getWidth() / 2 - scene.x * zoom;
    const offsetY = this.canvas.getHeight() / 2 - scene.y * zoom;
    this.canvas.setViewportTransform([zoom, 0, 0, zoom, offsetX, offsetY] as TMat2D);
    this.canvas.requestRenderAll();
    this.callbacks.onZoomChange?.(zoom);
  }

  /** Converts a point in surface CSS pixels into scene (coordinate space)
   * units: first into backing-store pixels, then through the inverse
   * viewportTransform.
   *
   * Fabric's getScenePoint() takes a DOM event; the arbiter deals in plain
   * numbers, so the inverse transform is applied directly here. Doing this
   * consistently is what keeps the ink under the fingertip at every zoom
   * level - the single most visible failure mode of a drawing board. */
  toScene(x: number, y: number): Point {
    const [scaleX, , , scaleY, translateX, translateY] = this.canvas.viewportTransform;
    const backingX = x * this.renderScale;
    const backingY = y * this.renderScale;
    return new Point((backingX - translateX) / scaleX, (backingY - translateY) / scaleY);
  }

  // --- stroke lifecycle, driven by the arbiter ---------------------------

  strokeBegin(x: number, y: number): void {
    const point = this.toScene(x, y);
    this.activePoints = [point.x, point.y];
    this.drawing = true;
    // Width is in scene units, so a stroke keeps the same weight relative to
    // the image no matter what zoom it was drawn at - a line drawn zoomed in
    // must not turn into a hairline when the player zooms back out.
    this.brush.width = PLAYER_STROKE_WIDTH;
    this.brush.onMouseDown(point, { e: syntheticEvent() });
  }

  strokeExtend(x: number, y: number): void {
    if (!this.drawing) return;
    const point = this.toScene(x, y);
    this.activePoints.push(point.x, point.y);
    this.brush.onMouseMove(point, { e: syntheticEvent() });
  }

  /** Finalizes the in-progress stroke into a real Fabric Path AND a
   * DrawingDocument stroke. */
  strokeEnd(): void {
    if (!this.drawing) return;
    this.drawing = false;
    this.brush.onMouseUp({ e: syntheticEvent() });

    // Fabric appends the finalized Path itself; tag it so the eraser can
    // match it back to the document stroke.
    const objects = this.canvas.getObjects();
    const created = objects[objects.length - 1] as StrokeObject | undefined;
    if (!created || created === this.baseImage) {
      this.activePoints = [];
      return;
    }

    const stroke: Omit<DrawingStroke, 'order'> = {
      id: createStrokeId(),
      tool: 'pen',
      layer: 'player',
      points: this.activePoints,
      color: PLAYER_STROKE_COLOR,
      width: PLAYER_STROKE_WIDTH,
    };
    created.peiraStrokeId = stroke.id;
    created.set({ selectable: false, evented: false });

    this.activePoints = [];
    this.document = addStroke(this.document, stroke, new Date().toISOString());
    this.canvas.requestRenderAll();
    this.callbacks.onDocumentChange(this.document);
  }

  /** Abandons the in-progress stroke without committing it. Used for
   * pointercancel and for tool changes mid-stroke. */
  strokeAbort(): void {
    if (!this.drawing) return;
    this.drawing = false;
    this.activePoints = [];
    // Clears the upper canvas the brush was rendering onto without letting
    // it run _finalizeAndAddPath, so no Path is ever added.
    this.brush._reset();
    this.canvas.clearContext(this.canvas.contextTop);
    this.canvas.requestRenderAll();
  }

  // --- viewport ----------------------------------------------------------

  /** Records the zoom a pinch is starting from. Every scale during that
   * gesture is applied against this reading rather than against the previous
   * frame, so per-frame rounding cannot accumulate into visible drift. */
  beginPinch(): void {
    this.pinchBaseZoom = this.canvas.getZoom();
  }

  /** Focal point arrives in CSS pixels; zoomToPoint expects backing-store
   * pixels. Skipping the conversion makes the image drift away from the
   * fingers as you pinch on any device where render scale is not 1. */
  zoomFromPinchStart(scaleFromStart: number, focalX: number, focalY: number): void {
    const next = clamp(this.pinchBaseZoom * scaleFromStart, MIN_ZOOM, MAX_ZOOM);
    this.canvas.zoomToPoint(new Point(focalX * this.renderScale, focalY * this.renderScale), next);
    this.canvas.requestRenderAll();
    this.callbacks.onZoomChange?.(next);
  }

  panBy(dx: number, dy: number): void {
    // relativePan takes backing-store deltas. It is deliberately NOT divided
    // by zoom: a finger moving 10 CSS px should move the image 10 CSS px at
    // every zoom level, which is what "the image sticks to your finger"
    // means.
    this.canvas.relativePan(new Point(dx * this.renderScale, dy * this.renderScale));
    this.canvas.requestRenderAll();
  }

  // --- erase -------------------------------------------------------------

  /** Whole-stroke erase: finds the topmost stroke under the point and
   * removes all of it. Partial pixel erasing is deliberately out of scope -
   * it would require either a raster layer (breaking the vector source of
   * truth) or stroke splitting (a far larger problem than V1 needs). */
  eraseAt(x: number, y: number): DrawingStroke | null {
    const scene = this.toScene(x, y);
    const target = this.findStrokeAt(scene);
    if (!target?.peiraStrokeId) return null;

    const removed = this.document.strokes.find((s) => s.id === target.peiraStrokeId) ?? null;
    this.canvas.remove(target);
    this.document = removeStroke(this.document, target.peiraStrokeId, new Date().toISOString());
    this.canvas.requestRenderAll();
    this.callbacks.onDocumentChange(this.document);
    return removed;
  }

  /** Hit-tests strokes topmost-first, with a tolerance that grows as the view
   * zooms out - at 0.5x zoom a 6px stroke is 3 screen pixels, which no finger
   * can hit reliably. */
  private findStrokeAt(scene: Point): StrokeObject | null {
    // 22 CSS px of fingertip, converted into scene units at the current zoom.
    const tolerance = Math.max(PLAYER_STROKE_WIDTH, (22 * this.renderScale) / this.canvas.getZoom());
    const objects = this.canvas.getObjects() as StrokeObject[];
    for (let i = objects.length - 1; i >= 0; i -= 1) {
      const object = objects[i];
      if (!object.peiraStrokeId) continue;
      const box = object.getBoundingRect();
      if (
        scene.x >= box.left - tolerance &&
        scene.x <= box.left + box.width + tolerance &&
        scene.y >= box.top - tolerance &&
        scene.y <= box.top + box.height + tolerance
      ) {
        return object;
      }
    }
    return null;
  }

  // --- document-level operations ----------------------------------------

  /** Rebuilds the canvas from a document. Used by undo/redo and by resume,
   * both of which restore a whole document rather than replaying operations. */
  async applyDocument(document: DrawingDocument): Promise<void> {
    this.document = document;
    const strokeObjects = (this.canvas.getObjects() as StrokeObject[]).filter((o) => o.peiraStrokeId);
    strokeObjects.forEach((object) => this.canvas.remove(object));

    const ordered = [...document.strokes].sort((a, b) => a.order - b.order);
    for (const stroke of ordered) this.renderStroke(stroke);

    this.canvas.requestRenderAll();
    this.callbacks.onDocumentChange(this.document);
  }

  /** Replays a stored stroke through the same brush that authored it, so a
   * restored drawing is pixel-identical to the one the player drew rather
   * than a different curve fitted to the same points. */
  private renderStroke(stroke: DrawingStroke): void {
    if (stroke.points.length < 2) return;
    const brush = new PencilBrush(this.canvas);
    brush.color = stroke.color;
    brush.width = stroke.width;
    brush.decimate = 0;

    brush.onMouseDown(new Point(stroke.points[0], stroke.points[1]), { e: syntheticEvent() });
    for (let i = 2; i < stroke.points.length; i += 2) {
      brush.onMouseMove(new Point(stroke.points[i], stroke.points[i + 1]), { e: syntheticEvent() });
    }
    brush.onMouseUp({ e: syntheticEvent() });

    const objects = this.canvas.getObjects();
    const created = objects[objects.length - 1] as StrokeObject | undefined;
    if (created && created !== this.baseImage) {
      created.peiraStrokeId = stroke.id;
      created.set({ selectable: false, evented: false });
    }
  }

  /** Flattened preview for fast display and PDF export. Never the source of
   * truth - see types.ts. Rendered at the document's coordinate space so the
   * preview's pixels line up with the vector data exactly. */
  async exportPreview(maxWidth = 1000): Promise<Blob | null> {
    const multiplier = Math.min(1, maxWidth / this.document.coordinate_width);
    const dataUrl = this.canvas.toDataURL({
      format: 'png',
      multiplier,
      left: 0,
      top: 0,
      width: this.document.coordinate_width,
      height: this.document.coordinate_height,
    });
    const response = await fetch(dataUrl);
    return response.blob();
  }

  dispose(): void {
    void this.canvas.dispose();
  }
}

/** Fabric's brush API requires an event object but only reads modifier keys
 * from it, which this board never uses. A bare object satisfies the contract
 * without fabricating a misleading synthetic PointerEvent. */
function syntheticEvent(): PointerEvent {
  return { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false } as PointerEvent;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
