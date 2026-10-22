// PREVIEW 3D: hand the play to the PEIRA 3D play viewer, shown inside Motion
// Lab's own page (Preview3DOverlay - full screen over the editor, which stays
// mounted, with "Back to Motion Lab").
//
// OFF unless VITE_MOTION_LAB_3D_URL is set, which no production build has yet.
// Motion Lab knows nothing about 3D here: it hands the viewer the play exactly
// as the coach made it (stances included). Everything else - reading the play,
// standing each man in his stance, animating it - is the viewer's.
//
// THE CONTRACT (version 1) - the viewer checks it strictly at its door
// (peira-3d-football-poc/src/play/motionLabContract.ts):
//
//   { contract: 'peira-motion-lab-3d', version: 1,
//     play: { id, revision, name, schemaVersion, updatedAt },
//     document: <the row's document, untouched> }
//
// A saved play is answered as the server holds it, once its pending save has
// landed. The UNSAVED play previews too (`play=draft`): the document on screen,
// with an identity that says so - id and revision null, draft: true. Nothing is
// saved to preview it.
//
// THE HANDSHAKE (`answerViewer`). The viewer opens at
// `?source=peira&play=<id | draft>&embed=1` and asks the page around it -
// { type: READY, requestId, playId } - until it is answered. Each request (one
// per page load of the viewer) is answered once, to the viewer's own origin
// only, with the play as it is AT THAT MOMENT - so a refresh inside the viewer
// shows the latest version, never a copy held here.
//
// (Until the connected-system cycle the viewer opened in a pop-up window,
// `viewIn3D`; that path was removed once the overlay replaced it.)

import type { MotionPlayDocument, MotionPlayRow } from '../api/motionLab'

export const VIEWER_3D_URL = (import.meta.env.VITE_MOTION_LAB_3D_URL as string | undefined) || null

export const READY = 'peira-3d:ready'
export const PLAY = 'peira-motion-lab:play'
export const PLAY_ERROR = 'peira-motion-lab:error'

export const CONTRACT = 'peira-motion-lab-3d'
export const CONTRACT_VERSION = 1

export interface ViewerPayload {
  contract: typeof CONTRACT
  version: typeof CONTRACT_VERSION
  play: { id: number; revision: number; name: string; schemaVersion: number; updatedAt: string }
  document: MotionPlayDocument
}

/** The unsaved play on screen, as the contract carries a draft: no id, no revision, said so. */
export interface DraftPayload {
  contract: typeof CONTRACT
  version: typeof CONTRACT_VERSION
  play: { id: null; revision: null; name: string; schemaVersion: number; updatedAt: string; draft: true }
  document: MotionPlayDocument
}

/** What a preview shows: a saved play (by server id), or the unsaved draft on screen. */
export type PreviewTarget = number | 'draft'

export function draftPayload(name: string, document: MotionPlayDocument, schemaVersion: number, now = new Date().toISOString()): DraftPayload {
  return {
    contract: CONTRACT,
    version: CONTRACT_VERSION,
    play: { id: null, revision: null, name, schemaVersion, updatedAt: now, draft: true },
    document,
  }
}

/** The viewer's address for a target - `embed` when it is shown inside Motion Lab. */
export function viewerUrlFor(viewerUrl: string, target: PreviewTarget, { embed = false } = {}): string {
  const url = new URL(viewerUrl)
  url.searchParams.set('source', 'peira')
  url.searchParams.set('play', String(target))
  if (embed) url.searchParams.set('embed', '1')
  return url.toString()
}

/** Listening for the viewer's messages (replaceable in tests). */
interface Deps {
  addListener: (fn: (e: MessageEvent) => void) => void
  removeListener: (fn: (e: MessageEvent) => void) => void
}

const browser: Deps = {
  addListener: (fn) => window.addEventListener('message', fn),
  removeListener: (fn) => window.removeEventListener('message', fn),
}

/**
 * THE HANDOFF'S CORE: answer `viewer`'s requests for `target` with `load()`.
 *
 * Only messages from that window, at the viewer's origin, naming this target,
 * with a sane request id; each request answered once, with whatever `load`
 * returns AT THAT MOMENT (so a refresh of the viewer shows the play as it is
 * now); answers go to the viewer's origin only. Returns stop.
 */
export function answerViewer(
  viewer: Window,
  viewerOrigin: string,
  target: PreviewTarget,
  load: () => Promise<ViewerPayload | DraftPayload>,
  deps: Deps = browser,
): () => void {
  const answered = new Set<string>()
  const onMessage = (e: MessageEvent) => {
    if (e.source !== viewer || e.origin !== viewerOrigin) return
    const data = e.data as { type?: unknown; requestId?: unknown; playId?: unknown } | null
    if (data?.type !== READY || typeof data.requestId !== 'string' || !data.requestId || data.requestId.length > 100) return
    if (data.playId !== target || answered.has(data.requestId)) return
    const requestId = data.requestId
    answered.add(requestId)
    load().then(
      (payload) => viewer.postMessage({ type: PLAY, requestId, payload }, viewerOrigin),
      (err: unknown) => viewer.postMessage({ type: PLAY_ERROR, requestId, message: err instanceof Error ? err.message : 'the play could not be loaded' }, viewerOrigin),
    )
  }
  deps.addListener(onMessage)
  return () => deps.removeListener(onMessage)
}

/** The saved row as the viewer's contract carries it: identity from the row's columns, the document untouched. */
export function toViewerPayload(row: MotionPlayRow): ViewerPayload {
  return {
    contract: CONTRACT,
    version: CONTRACT_VERSION,
    play: { id: row.id, revision: row.revision, name: row.name, schemaVersion: row.schema_version, updatedAt: row.updated_at },
    document: row.document,
  }
}
