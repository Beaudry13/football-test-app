// VIEW IN 3D (V6): hand the SAVED play to the PEIRA 3D play viewer.
//
// A development bridge, OFF unless VITE_MOTION_LAB_3D_URL is set - it is not in
// any production build - so Motion Lab ships exactly as before. Motion Lab
// knows nothing about 3D here: it opens the viewer and hands it the play exactly
// as the server stores it (the coach intent, stances included). Everything else
// - reading the play, standing each man in his stance, animating it - is the
// viewer's.
//
// THE CONTRACT (version 1) - the viewer checks it strictly at its door
// (peira-3d-football-poc/src/play/motionLabContract.ts):
//
//   { contract: 'peira-motion-lab-3d', version: 1,
//     play: { id, revision, name, schemaVersion, updatedAt },
//     document: <the row's document, untouched> }
//
// THE HANDSHAKE. The viewer opens at `?source=peira&play=<id>` and asks the
// window that opened it - { type: READY, requestId, playId } - until it is
// answered. Each request (one per page load of the viewer) is answered once, to
// the viewer's own origin only, with the row fetched from the server AT THAT
// MOMENT - so a refresh of the viewer shows the latest save, never a copy held
// here. A newer "View in 3D" takes the viewer window over: the earlier handoff
// stops answering, so the window can never be handed the previous play. The
// handoff ends when the viewer window closes.
//
// THE SAVED PLAY, not the screen - which is why the page offers this only once
// the play is saved.

import { getMotionPlay, type MotionPlayDocument, type MotionPlayRow } from '../api/motionLab'

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

/** The saved row as the viewer's contract carries it: identity from the row's columns, the document untouched. */
export function toViewerPayload(row: MotionPlayRow): ViewerPayload {
  return {
    contract: CONTRACT,
    version: CONTRACT_VERSION,
    play: { id: row.id, revision: row.revision, name: row.name, schemaVersion: row.schema_version, updatedAt: row.updated_at },
    document: row.document,
  }
}

/** How often the handoff looks to see whether the viewer window has closed. */
const WATCH_MS = 2000

interface Deps {
  open: (url: string, target: string) => Window | null
  fetchRow: (id: number) => Promise<MotionPlayRow>
  addListener: (fn: (e: MessageEvent) => void) => void
  removeListener: (fn: (e: MessageEvent) => void) => void
  every: (ms: number, fn: () => void) => () => void
}

const browser: Deps = {
  open: (url, target) => window.open(url, target),
  fetchRow: getMotionPlay,
  addListener: (fn) => window.addEventListener('message', fn),
  removeListener: (fn) => window.removeEventListener('message', fn),
  every: (ms, fn) => {
    const id = window.setInterval(fn, ms)
    return () => window.clearInterval(id)
  },
}

/** The handoff the viewer window is listening to; a newer View in 3D replaces it. */
let active: (() => void) | null = null

/**
 * Open the viewer for saved play `serverId` and answer it whenever it asks.
 * Must be called from the click itself (a popup opened later is blocked).
 * Returns false when the window could not be opened.
 */
export function viewIn3D(viewerUrl: string, serverId: number, deps: Deps = browser): boolean {
  const url = new URL(viewerUrl)
  url.searchParams.set('source', 'peira')
  url.searchParams.set('play', String(serverId))
  const viewer = deps.open(url.toString(), 'peira-3d-viewer')
  if (!viewer) return false
  active?.()
  const answered = new Set<string>()
  const onMessage = (e: MessageEvent) => {
    if (e.source !== viewer || e.origin !== url.origin) return
    const data = e.data as { type?: unknown; requestId?: unknown; playId?: unknown } | null
    if (data?.type !== READY || typeof data.requestId !== 'string' || !data.requestId || data.requestId.length > 100) return
    if (data.playId !== serverId || answered.has(data.requestId)) return
    const requestId = data.requestId
    answered.add(requestId)
    deps.fetchRow(serverId).then(
      (row) => viewer.postMessage({ type: PLAY, requestId, payload: toViewerPayload(row) }, url.origin),
      (err: unknown) => viewer.postMessage({ type: PLAY_ERROR, requestId, message: err instanceof Error ? err.message : 'the saved play could not be loaded' }, url.origin),
    )
  }
  const stopWatching = deps.every(WATCH_MS, () => {
    if (viewer.closed) stop()
  })
  const stop = () => {
    stopWatching()
    deps.removeListener(onMessage)
    if (active === stop) active = null
  }
  deps.addListener(onMessage)
  active = stop
  return true
}
