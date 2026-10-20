import { useState } from 'react'

/**
 * PREVIEW 3D: PEIRA's signature view, one button in the top bar.
 *
 * WITH A VIEWER (VITE_MOTION_LAB_3D_URL is set) it opens the saved play in the
 * 3D viewer - `onOpen` is the page's handoff (viewIn3D.ts), which also says
 * what to do first when the play is not saved yet.
 *
 * WITHOUT ONE - every production build today - it never pretends. The button
 * says "Soon", is announced as unavailable, and pressing it explains instead
 * of doing nothing, so "how do I see this in 3D?" always has an answer on the
 * screen. Turning the viewer on changes nothing here but `available`.
 */
export function Preview3D({ available, onOpen }: { available: boolean; onOpen: () => void }) {
  const [explaining, setExplaining] = useState(false)

  if (available) {
    return (
      <div className="preview-3d">
        <button className="preview-3d-btn" onClick={onOpen} title="Open the saved play in 3D">
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
          <span>When it is, this button opens your saved play in 3D, with every player running what you drew.</span>
          <button onClick={() => setExplaining(false)}>OK</button>
        </div>
      )}
    </div>
  )
}
