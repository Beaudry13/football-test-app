// VIEW IN 3D (V6): hand the SAVED play to the PEIRA 3D play viewer.
//
// A development bridge, OFF unless VITE_MOTION_LAB_3D_URL is set - it is not in
// any production build - so Motion Lab ships exactly as before. Motion Lab
// knows nothing about 3D here: it opens the viewer's URL and hands it the play
// row exactly as the server stores it (the coach intent, stances included).
// Everything else - reading the play, standing each man in his stance,
// animating it - is the viewer's.
//
// THE HANDSHAKE, and why it is one. The viewer loads in its own window and
// says "ready" to the window that opened it; only then, and only to the
// viewer's own origin, is the play sent. Nothing is sent before the viewer
// asks, to anyone else, or more than once.
//
// THE SAVED PLAY, not the screen. The row is fetched from the server at the
// moment of the handoff, so what the viewer shows is what was saved - which
// is why the page offers this only once the play is saved.

import { getMotionPlay, type MotionPlayRow } from '../api/motionLab'

export const VIEWER_3D_URL = (import.meta.env.VITE_MOTION_LAB_3D_URL as string | undefined) || null

export const READY = 'peira-3d:ready'
export const PLAY = 'peira-motion-lab:play'

/** How long the handoff waits for the viewer to say it is ready. */
const WAIT_MS = 60000

interface Deps {
  open: (url: string, target: string) => Window | null
  fetchRow: (id: number) => Promise<MotionPlayRow>
  addListener: (fn: (e: MessageEvent) => void) => void
  removeListener: (fn: (e: MessageEvent) => void) => void
}

const browser: Deps = {
  open: (url, target) => window.open(url, target),
  fetchRow: getMotionPlay,
  addListener: (fn) => window.addEventListener('message', fn),
  removeListener: (fn) => window.removeEventListener('message', fn),
}

/**
 * Open the viewer for saved play `serverId` and hand it over when it asks.
 * Must be called from the click itself (a popup opened later is blocked).
 * Returns false when the window could not be opened.
 */
export function viewIn3D(viewerUrl: string, serverId: number, deps: Deps = browser): boolean {
  const url = new URL(viewerUrl)
  url.searchParams.set('source', 'peira')
  const viewer = deps.open(url.toString(), 'peira-3d-viewer')
  if (!viewer) return false
  const row = deps.fetchRow(serverId)
  let sent = false
  const onMessage = (e: MessageEvent) => {
    if (sent || e.source !== viewer || e.origin !== url.origin) return
    if ((e.data as { type?: unknown } | null)?.type !== READY) return
    sent = true
    stop()
    void row.then((play) => viewer.postMessage({ type: PLAY, play }, url.origin)).catch(() => undefined)
  }
  const timer = setTimeout(() => stop(), WAIT_MS)
  const stop = () => {
    clearTimeout(timer)
    deps.removeListener(onMessage)
  }
  deps.addListener(onMessage)
  return true
}
