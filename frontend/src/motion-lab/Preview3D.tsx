import { useState } from 'react'

/**
 * PREVIEW 3D: PEIRA's signature view, one button in the top bar.
 *
 * WITH A VIEWER (VITE_MOTION_LAB_3D_URL is set) it shows the play on screen in
 * the 3D viewer, inside Motion Lab - `onOpen` is the page's (Preview3DOverlay),
 * saved or not.
 *
 * WITHOUT ONE it never pretends: the button says "Soon", is announced as
 * unavailable, and pressing it explains instead of doing nothing. That state is
 * for local development only - production renders no Preview 3D at all until a
 * viewer is configured (owner decision, 20 October 2026; MotionLabEditorPage).
 * Turning the viewer on changes nothing here but `available`.
 */
export function Preview3D({ available, onOpen }: { available: boolean; onOpen: () => void }) {
  const [explaining, setExplaining] = useState(false)

  if (available) {
    return (
      <div className="preview-3d">
        <button className="preview-3d-btn" onClick={onOpen} title="See this play in 3D">
          Preview 3D
        </button>
      </div>
    )
  }

  return (
    <div className="ball-menu preview-3d">
      <button
        className={`preview-3d-btn unavailable${explaining ? ' active' : ''}`}
        aria-disabled="true"
        aria-expanded={explaining}
        onClick={() => setExplaining((open) => !open)}
        title="3D preview is not switched on yet"
      >
        Preview 3D<span className="soon">Soon</span>
      </button>
      {explaining && (
        <div
          className="popover preview-3d-pop"
          role="note"
          onKeyDown={(e) => {
            // The editor's own keys stay out; Escape closes it.
            e.stopPropagation()
            if (e.key === 'Escape') setExplaining(false)
          }}
        >
          <b>3D preview isn't switched on yet.</b>
          <span>When it is, this button shows your play in 3D, with every player running what you drew.</span>
          <button onClick={() => setExplaining(false)}>OK</button>
        </div>
      )}
    </div>
  )
}
