import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MotionLabEditor } from './authoring/MotionLabEditor'
import { createLocalPlayRepository } from './storage/localPlayRepository'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import './motionLab.css'

/**
 * MOTION LAB, INSIDE PEIRA (P1).
 *
 * A full-screen tool, like annotation: it renders its own chrome and sits
 * outside NotebookLayout so the field keeps the whole screen. Everything
 * Motion Lab draws lives under .motion-lab-root, which is what keeps its styles
 * from reaching the rest of PEIRA (see motionLab.css).
 *
 * Plays are saved in THIS BROWSER only for now (LocalPlayRepository). That is
 * why the route is platform-owner only: a coach must not build a season's
 * worth of plays in storage that clearing site data would erase. P2 moves
 * storage to PEIRA's server behind the same repository boundary.
 *
 * Loaded lazily by MotionLabRoute, so nobody else downloads the editor.
 */
export default function MotionLabPage() {
  // One repository for the editor's lifetime - see MotionLabEditor.
  const [repository] = useState(createLocalPlayRepository)
  const navigate = useNavigate()
  useDocumentTitle('Motion Lab — Peira')

  return (
    <div className="motion-lab-root">
      <MotionLabEditor
        repository={repository}
        exit={
          <button onClick={() => navigate('/dashboard')} title="Back to Peira">
            ← Peira
          </button>
        }
      />
    </div>
  )
}
