import { useEffect, useRef } from 'react'
import { answerViewer, viewerUrlFor, type DraftPayload, type PreviewTarget, type ViewerPayload } from './viewIn3D'

/**
 * PREVIEW 3D, INSIDE MOTION LAB. The 3D viewer fills the screen over the editor
 * - which stays exactly as it was underneath - and "Back to Motion Lab" (or
 * Escape) closes it. No new tab, no pop-up to allow, nothing to save first.
 *
 * The viewer asks this page for the play; `load` answers with it as it is at
 * that moment (see viewIn3D.answerViewer), so a refresh inside the viewer
 * shows the latest version. The bar above it says which play this is - the
 * viewer's own title block is hidden in this embedded mode.
 */
export function Preview3DOverlay({
  viewerUrl,
  target,
  playName,
  load,
  onClose,
}: {
  viewerUrl: string
  target: PreviewTarget
  playName: string
  load: () => Promise<ViewerPayload | DraftPayload>
  onClose: () => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  // The latest loader, without restarting the handoff on every render.
  const loader = useRef(load)
  loader.current = load

  useEffect(() => {
    const viewer = frame.current?.contentWindow
    if (!viewer) return
    return answerViewer(viewer, new URL(viewerUrl).origin, target, () => loader.current())
  }, [viewerUrl, target])

  useEffect(() => {
    back.current?.focus()
    // Escape here (the viewer keeps its own keys while it has the focus).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="preview-3d-overlay" role="dialog" aria-label={`${playName} in 3D`}>
      <div className="preview-3d-bar">
        <button ref={back} type="button" className="preview-3d-back" onClick={onClose}>
          ← Back to Motion Lab
        </button>
        <span className="preview-3d-name" title={playName}>
          {playName}
        </span>
        {target === 'draft' && (
          <span className="preview-3d-tag" title="Not saved yet - this is the play as it is on screen">
            Unsaved
          </span>
        )}
        <span className="preview-3d-kind">3D preview</span>
      </div>
      <iframe ref={frame} className="preview-3d-frame" src={viewerUrlFor(viewerUrl, target, { embed: true })} title={`${playName} in 3D`} allow="fullscreen" />
    </div>
  )
}
