import { util, type Canvas, type FabricObject } from 'fabric';
import { makeId } from './shapeFactories';
import { ANNOTATION_PROPS } from './types';

/** How far a pasted copy is nudged from the original, so it reads as a new
 * shape rather than looking like nothing happened. */
export const PASTE_OFFSET = 16;

/**
 * Module-scoped on purpose: AnnotationCanvas is fully remounted per image
 * (its `key` changes), so component state would drop the clipboard the moment
 * a coach navigated to the next question's image. Keeping it here lets a
 * shape be copied on one image and pasted onto another within the session.
 * Not persisted - a page reload clears it.
 */
let clipboard: Record<string, unknown> | null = null;

export function copyObject(object: FabricObject): void {
  clipboard = object.toObject(ANNOTATION_PROPS) as Record<string, unknown>;
}

export function hasClipboardContent(): boolean {
  return clipboard !== null;
}

/** Test seam - resets the session clipboard between cases. */
export function clearClipboard(): void {
  clipboard = null;
}

/**
 * Adds a copy of whatever was last copied, offset and selected so it's
 * immediately draggable. Returns the pasted object, or null if nothing has
 * been copied yet.
 */
export async function pasteObject(canvas: Canvas): Promise<FabricObject | null> {
  if (!clipboard) return null;

  const [pasted] = (await util.enlivenObjects([clipboard])) as FabricObject[];
  if (!pasted) return null;

  // Nudged down-right, but pulled back inside the canvas when that would push
  // the copy off the edge - a paste the coach can't see reads as a no-op.
  const width = canvas.getWidth();
  const height = canvas.getHeight();
  const left = Math.min((pasted.left ?? 0) + PASTE_OFFSET, Math.max(0, width - PASTE_OFFSET));
  const top = Math.min((pasted.top ?? 0) + PASTE_OFFSET, Math.max(0, height - PASTE_OFFSET));
  const dx = left - (pasted.left ?? 0);
  const dy = top - (pasted.top ?? 0);

  pasted.set({ left, top, id: makeId() });

  // segStart/segEnd are absolute canvas coordinates captured when the shape
  // was tagged, and currentSegment() derives the live endpoints from them -
  // they have to move with the copy or its endpoint handles would still grab
  // at the original's position.
  if (pasted.get('hasEditableEndpoints')) {
    const segStart = pasted.get('segStart') as { x: number; y: number } | undefined;
    const segEnd = pasted.get('segEnd') as { x: number; y: number } | undefined;
    if (segStart && segEnd) {
      pasted.set({
        segStart: { x: segStart.x + dx, y: segStart.y + dy },
        segEnd: { x: segEnd.x + dx, y: segEnd.y + dy },
        segRefLeft: left,
        segRefTop: top,
      });
    }
  }

  pasted.setCoords();
  canvas.add(pasted);
  canvas.setActiveObject(pasted);
  canvas.requestRenderAll();
  return pasted;
}
