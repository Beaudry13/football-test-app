/** Pure operations over a DrawingDocument. No React, no Fabric, no network -
 * the engine calls these, and so can the backend-facing adapters, tests, and
 * any future coach-side viewer. */

import {
  DRAWING_DOCUMENT_FORMAT,
  DRAWING_DOCUMENT_VERSION,
  type DrawingDocument,
  type DrawingLayer,
  type DrawingSourceImage,
  type DrawingStroke,
} from './types';

/** Widest logical coordinate space a drawing is authored in.
 *
 * Deliberately equal to the annotation editor's MAX_CANVAS_WIDTH so a coach
 * diagram and a player drawing over the same photo share one space and can be
 * composited without rescaling either. */
export const COORDINATE_MAX_WIDTH = 1400;

export interface CreateDocumentOptions {
  source: DrawingSourceImage;
  /** Defaults to COORDINATE_MAX_WIDTH capped at the image's real width -
   * upscaling the coordinate space past the photo's own resolution buys no
   * precision and costs payload size. */
  coordinateWidth?: number;
  now?: string;
}

export function createDocument({ source, coordinateWidth, now }: CreateDocumentOptions): DrawingDocument {
  const width = Math.round(
    coordinateWidth ?? Math.min(COORDINATE_MAX_WIDTH, source.natural_width || COORDINATE_MAX_WIDTH),
  );
  const aspect = source.natural_height / source.natural_width;
  return {
    format: DRAWING_DOCUMENT_FORMAT,
    version: DRAWING_DOCUMENT_VERSION,
    source,
    coordinate_width: width,
    coordinate_height: Math.round(width * (Number.isFinite(aspect) && aspect > 0 ? aspect : 1)),
    strokes: [],
    created_at: now,
    updated_at: now,
  };
}

export function isEmpty(document: DrawingDocument): boolean {
  return document.strokes.length === 0;
}

/** The single answer-presence rule for drawings, exported so every consumer
 * (player board, submit guard, coach viewer, future backend mirror) agrees.
 * A document with no strokes is not an answer - the envelope alone is just
 * the image the player was shown. */
export function hasDrawnAnswer(document: DrawingDocument | null | undefined): boolean {
  return !!document && document.strokes.length > 0;
}

export function nextOrder(document: DrawingDocument): number {
  return document.strokes.reduce((max, stroke) => Math.max(max, stroke.order), -1) + 1;
}

export function addStroke(
  document: DrawingDocument,
  stroke: Omit<DrawingStroke, 'order'> & { order?: number },
  now?: string,
): DrawingDocument {
  const complete: DrawingStroke = { ...stroke, order: stroke.order ?? nextOrder(document) };
  return { ...document, strokes: [...document.strokes, complete], updated_at: now ?? document.updated_at };
}

export function removeStroke(document: DrawingDocument, strokeId: string, now?: string): DrawingDocument {
  const strokes = document.strokes.filter((stroke) => stroke.id !== strokeId);
  if (strokes.length === document.strokes.length) return document;
  return { ...document, strokes, updated_at: now ?? document.updated_at };
}

export function clearStrokes(document: DrawingDocument, layer: DrawingLayer = 'player', now?: string): DrawingDocument {
  const strokes = document.strokes.filter((stroke) => stroke.layer !== layer);
  if (strokes.length === document.strokes.length) return document;
  return { ...document, strokes, updated_at: now ?? document.updated_at };
}

export function strokesForLayer(document: DrawingDocument, layer: DrawingLayer): DrawingStroke[] {
  return document.strokes.filter((stroke) => stroke.layer === layer);
}

/** Why a document cannot be trusted against the image currently on screen. */
export type SourceMismatch = 'none' | 'different-image' | 'different-version' | 'different-dimensions';

/** Detects the coach-replaced-the-image case.
 *
 * 'different-version' is the interesting one: same image record, different
 * content. The strokes are still geometrically valid against the coordinate
 * space, but they were drawn over different pixels, so a viewer should say so
 * rather than render them as if nothing changed. */
export function checkSource(document: DrawingDocument, current: DrawingSourceImage): SourceMismatch {
  if (document.source.image_id !== current.image_id) return 'different-image';
  if (
    document.source.image_version !== null &&
    current.image_version !== null &&
    document.source.image_version !== current.image_version
  ) {
    return 'different-version';
  }
  if (
    document.source.natural_width !== current.natural_width ||
    document.source.natural_height !== current.natural_height
  ) {
    return 'different-dimensions';
  }
  return 'none';
}

/** Structural validation for anything arriving from storage or the network.
 * Returns the problems found rather than throwing, so a caller can decide
 * between refusing to render and rendering with a warning. */
export function validateDocument(value: unknown): string[] {
  const problems: string[] = [];
  if (typeof value !== 'object' || value === null) return ['not an object'];
  const doc = value as Partial<DrawingDocument>;

  if (doc.format !== DRAWING_DOCUMENT_FORMAT) problems.push(`unexpected format: ${String(doc.format)}`);
  if (typeof doc.version !== 'number') problems.push('missing version');
  else if (doc.version > DRAWING_DOCUMENT_VERSION) problems.push(`document version ${doc.version} is newer than this client`);

  if (!doc.coordinate_width || !doc.coordinate_height) problems.push('missing coordinate space');
  if (!doc.source || typeof doc.source.image_id !== 'string') problems.push('missing source image reference');
  if (!Array.isArray(doc.strokes)) {
    problems.push('missing strokes array');
    return problems;
  }

  doc.strokes.forEach((stroke, index) => {
    if (typeof stroke?.id !== 'string') problems.push(`stroke ${index}: missing id`);
    if (!Array.isArray(stroke?.points) || stroke.points.length < 2) problems.push(`stroke ${index}: needs at least one point`);
    else if (stroke.points.length % 2 !== 0) problems.push(`stroke ${index}: odd point count`);
  });
  return problems;
}

/** Rough serialized size, used by autosave to decide between sending the
 * whole document and warning that it has outgrown a single request. */
export function estimatePayloadBytes(document: DrawingDocument): number {
  // Each coordinate serializes to ~7 bytes ("1234.5,"), plus per-stroke
  // envelope overhead. Cheaper and steadier than JSON.stringify().length on
  // every keystroke-equivalent, and only ever used for threshold decisions.
  const pointBytes = document.strokes.reduce((sum, stroke) => sum + stroke.points.length * 7, 0);
  return pointBytes + document.strokes.length * 120 + 200;
}

/** Ids are only ever compared within one document, so a counter-plus-random
 * suffix is sufficient and avoids depending on crypto.randomUUID, which is
 * unavailable on insecure origins - exactly how a phone reaches the dev
 * server over http://<LAN-IP>:5173 during the real-device gate. */
let strokeCounter = 0;
export function createStrokeId(): string {
  strokeCounter += 1;
  return `s${strokeCounter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
