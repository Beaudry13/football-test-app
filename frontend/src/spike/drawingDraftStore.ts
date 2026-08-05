/** Minimal IndexedDB draft store for the drawing spike.
 *
 * Tier 1 of the two-tier autosave described in docs/DESIGN-draw-on-image.md:
 * every completed stroke is written locally, so a refresh, a crash, or
 * Safari evicting a backgrounded tab never costs the player their work -
 * with no network involved at all. Tier 2 (the server save) is deliberately
 * NOT part of this spike; what we need to prove on real hardware is that
 * local persistence survives the things phones actually do.
 *
 * IndexedDB rather than localStorage because stroke JSON for a detailed
 * drawing runs well past localStorage's ~5MB origin budget, and because
 * localStorage writes are synchronous and would jank the drawing loop.
 */

const DB_NAME = 'peira-drawing-spike';
const DB_VERSION = 1;
const STORE = 'drafts';

export interface DrawingDraft {
  key: string;
  strokes: unknown[];
  canvasWidth: number;
  canvasHeight: number;
  updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** All three helpers swallow failures and degrade to "no draft available".
 * Safari in Private Browsing has historically thrown on IndexedDB access,
 * and a drawing board that white-screens because persistence is unavailable
 * is far worse than one that simply doesn't remember. */
export async function saveDraft(draft: DrawingDraft): Promise<boolean> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(draft);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch {
    return false;
  }
}

export async function loadDraft(key: string): Promise<DrawingDraft | null> {
  try {
    const db = await openDb();
    const draft = await new Promise<DrawingDraft | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => resolve((request.result as DrawingDraft) ?? null);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return draft;
  } catch {
    return null;
  }
}

export async function clearDraft(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    db.close();
  } catch {
    /* nothing to clear */
  }
}
