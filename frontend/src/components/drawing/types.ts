/** The Drawing Document - Peira's portable, versioned representation of
 * everything drawn on top of a source image.
 *
 * This format is the contract between the drawing engine and every feature
 * that will eventually store one (quiz answers first, then scouting reports,
 * coach corrections, install packets, evaluations). The engine itself knows
 * nothing about quizzes; a caller hands it a document and gets one back.
 *
 * WHY VECTORS AND NOT A SCREENSHOT
 * --------------------------------
 * A flattened PNG cannot be re-rendered at a different size, cannot be
 * partially undone, cannot be layered under or over a coach's version, and
 * cannot be re-themed. The structured strokes are the source of truth; the
 * flattened preview is a derived convenience for fast lists and PDF export.
 *
 * WHY THE COORDINATE SPACE IS PINNED
 * ----------------------------------
 * Strokes are stored in a logical coordinate space that is fixed at creation
 * and never recomputed. Render scale (how many device pixels back that space)
 * varies by device and zoom level; the coordinate space does not. This is the
 * only thing that keeps a drawing from shifting when it is reopened on a
 * different phone, exported to PDF, or viewed by the coach on a desktop.
 *
 * The annotation editor learned this the hard way - see the comment atop
 * `annotation/canvasSizing.ts`, where the canvas width doubles as the
 * coordinate space and therefore can never be changed in place. This format
 * pins the space explicitly rather than inferring it, so the same class of
 * bug cannot recur here.
 */

export const DRAWING_DOCUMENT_FORMAT = 'peira.drawing';

/** Bump only for changes that older readers cannot handle. Additive optional
 * fields do not need a bump; a reader that ignores them still renders
 * correctly, which is the bar. */
export const DRAWING_DOCUMENT_VERSION = 1;

/** Which pass a stroke belongs to, so the coach's eventual Image Only /
 * Coach Version / Player Submission toggle is a filter over one document
 * rather than three incompatible payloads. Phase 0 only ever writes 'player',
 * but the field exists now because retrofitting a layer concept onto stored
 * documents later would require a data migration. */
export type DrawingLayer = 'player' | 'coach';

export interface DrawingStroke {
  id: string;
  tool: 'pen';
  layer: DrawingLayer;
  /** Flat [x0, y0, x1, y1, ...] in coordinate space. Flat rather than
   * {x,y} objects: roughly half the JSON bytes for the same data, which
   * matters directly for the autosave payload budget on cell service. */
  points: number[];
  color: string;
  /** In coordinate-space units, so a stroke keeps its visual weight relative
   * to the image at any render scale. */
  width: number;
  opacity?: number;
  /** Creation order, preserved independently of array position so that a
   * future reordering or merge cannot silently change what sits on top. */
  order: number;
  created_at?: string;
}

/** An immutable reference to exactly which image was drawn on.
 *
 * A coach can replace a question's image after a player has answered. If the
 * drawing only referenced "this question's current image", every stroke would
 * silently relocate onto a photo it was never drawn against - a wrong answer
 * manufactured by an edit. Pinning the identity AND the dimensions means a
 * mismatch is detectable at render time rather than invisible. */
export interface DrawingSourceImage {
  /** Stable id of the image record the strokes were authored against. */
  image_id: string;
  /** Content identity where available (storage key, hash, or updated_at).
   * Null for legacy rows that predate versioning. */
  image_version: string | null;
  natural_width: number;
  natural_height: number;
}

export interface DrawingPreviewMeta {
  width: number;
  height: number;
  generated_at: string;
}

export interface DrawingDocument {
  format: typeof DRAWING_DOCUMENT_FORMAT;
  version: number;
  source: DrawingSourceImage;
  /** The logical space every stroke's points are relative to. Fixed at
   * creation. Never recomputed from the viewport. */
  coordinate_width: number;
  coordinate_height: number;
  strokes: DrawingStroke[];
  created_at?: string;
  updated_at?: string;
  /** Server-assigned, monotonically increasing. Used by autosave to detect a
   * newer drawing rather than blindly overwriting it. */
  revision?: number;
  preview?: DrawingPreviewMeta | null;
}

/** The player's pen. One fixed color in V1.
 *
 * Electric cyan, chosen to stay legible against grass, turf, dark jerseys and
 * white lines, and to be unmistakable next to every coach annotation color in
 * `annotation/types.ts` (red, amber, teal, navy, white, black). A player's
 * mark must never be confusable with the coach's own diagram underneath it. */
export const PLAYER_STROKE_COLOR = '#00E5FF';
export const PLAYER_STROKE_WIDTH = 6;
