import type { DrawingDocument } from '../../components/drawing/types';
import type { StoredDraft } from './drawingDraft';

/** What the server said this attempt has stored for one question. */
export interface ServerDrawing {
  document: DrawingDocument;
  revision: number;
}

export type ResumeReason =
  | 'no-draft'
  | 'source-mismatch'
  | 'local-only'
  | 'draft-unprovable'
  | 'draft-continues-server'
  | 'server-newer'
  | 'impossible-revision';

export interface ResumeDecision {
  document: DrawingDocument | null;
  /** The revision any subsequent save must be based on. null when nothing has
   *  ever been saved for this question. */
  baseRevision: number | null;
  /** True when the player is about to see something other than the local work
   *  they left behind, and deserves to be told why. */
  replacedLocalWork: boolean;
  reason: ResumeReason;
}

/** WHICH DRAWING A RESUMED ATTEMPT SHOWS.
 *
 * THE SERVER REVISION IS THE ORDERING MECHANISM. Nothing here compares a clock
 * - not `Date.now()`, not a saved-at, not a localStorage timestamp. Device
 * clocks are wrong often enough that "newer" decided by time is a coin flip,
 * and `revision` already expresses "happened after" exactly, because only a
 * successful server write can produce one.
 *
 * The local draft may win ONLY where it can prove it continued from the
 * version the server currently holds. Anything it cannot prove, it loses -
 * which is what stops a stale phone in a coat pocket from overwriting work
 * saved on a laptop an hour later.
 *
 * Evaluated in order; the first gate that applies decides.
 */
export function resolveResumeDrawing(
  server: ServerDrawing | null,
  draft: StoredDraft | null,
  /** The DELIVERED image's id, as the drawing document spells it.
   *
   *  Deliberately just the id rather than a full DrawingSourceImage: that
   *  comparison also checks natural pixel dimensions, which are only known
   *  after the image has been measured - not at mount. Passing a partial
   *  source made every legitimate draft look like it belonged to a different
   *  picture, and silently discarded it. Identity is the thing that actually
   *  binds a drawing to an image, and it is what the server enforces. */
  deliveredImageId: string | null,
): ResumeDecision {
  const serverDecision = (reason: ResumeReason, replacedLocalWork: boolean): ResumeDecision => ({
    document: server ? server.document : null,
    baseRevision: server ? server.revision : null,
    replacedLocalWork,
    reason,
  });

  if (!draft) return serverDecision('no-draft', false);

  // 1. BINDING. A draft made on a different picture is not this attempt's
  //    work - rendering it would put the player's strokes over an image they
  //    never drew on. The server refuses such a document too (Phase A); this
  //    is the client half, so it is discarded before it is ever shown.
  if (deliveredImageId && draft.document.source?.image_id !== deliveredImageId) {
    return serverDecision('source-mismatch', false);
  }

  // 2. NOTHING SAVED YET. The draft is the only copy that exists - typically a
  //    player who drew while their connection was failing. It must win, or the
  //    autosave outage silently becomes data loss.
  if (!server) {
    return {
      document: draft.document,
      baseRevision: null,
      replacedLocalWork: false,
      reason: 'local-only',
    };
  }

  // 3. UNPROVABLE. A draft with no base revision predates any successful save
  //    (or was written by a pre-Phase-B client). It cannot demonstrate that it
  //    continued from what the server holds, so the server wins.
  if (draft.base_revision === null) return serverDecision('draft-unprovable', true);

  // 4. AN UNSAVED CONTINUATION. The draft was built on exactly the version the
  //    server still holds, so it is that version plus strokes that never made
  //    it out. Keeping the server copy here would throw away real work.
  if (draft.base_revision === server.revision) {
    return {
      document: draft.document,
      baseRevision: server.revision,
      replacedLocalWork: false,
      reason: 'draft-continues-server',
    };
  }

  // 5. ANOTHER DEVICE SAVED SINCE. The draft's base is behind the server, so
  //    somebody - the same player on another phone - has saved newer work.
  if (draft.base_revision < server.revision) return serverDecision('server-newer', true);

  // 6. IMPOSSIBLE. A revision ahead of the server cannot come from an honest
  //    client. Treated defensively rather than trusted.
  return serverDecision('impossible-revision', true);
}

/** Player-safe explanation for a resume that replaced local work.
 *
 * Deliberately calm and free of mechanism: "revision" and "conflict" mean
 * nothing to a player mid-quiz, and alarming them about a drawing that was
 * correctly recovered would be worse than saying nothing. */
export const DRAWING_RESTORED_MESSAGE =
  'Your drawing was updated on another device. The latest saved version has been restored.';

/** The SAME situation seen from the other side: the player is drawing right
 * now, and another device saved first.
 *
 * Shares the opening sentence so a player meets one vocabulary for
 * "another device", and then says something different because the OUTCOME is
 * different - their local drawing is still on screen and still wins at submit.
 * Reusing the resume wording here would tell them their work had been
 * replaced when it had not. */
export const ACTIVE_EDIT_CONFLICT_MESSAGE =
  'Your drawing was updated on another device. Your current changes are still here and will be saved when you submit.';
