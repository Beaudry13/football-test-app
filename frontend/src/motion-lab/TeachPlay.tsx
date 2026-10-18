import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { PlayPicture, type DrawnStill } from '../components/football/PlayPicture'
import { TeachView, type TeachSlide } from '../components/teach/TeachView'
import type { Play } from './engine/play'
import { MomentPicker } from './MomentPicker'
import { drawPlay, IMAGE_HEIGHT, IMAGE_WIDTH } from './playImage'
import { playerAt } from './playImageLayout'
import { hasMotion, roleName } from './playRep'
import { momentsFor, presnapOf, type DecisionMoment } from './presnap'

/** The coach's words for a play, kept on this device for the next time he teaches it. */
const notesKey = (playId: string) => `peira.motionLab.teachNotes.${playId}`
function readNotes(playId: string): string {
  try {
    return localStorage.getItem(notesKey(playId)) ?? ''
  } catch {
    return ''
  }
}
function writeNotes(playId: string, notes: string) {
  try {
    if (notes.trim()) localStorage.setItem(notesKey(playId), notes)
    else localStorage.removeItem(notesKey(playId))
  } catch {
    // A private window: the notes just are not remembered.
  }
}

/**
 * MOTION LAB -> TEACH: put this play on the meeting-room screen, now.
 *
 * One small panel: tap the man to watch (his ring follows him), choose where
 * the play stops (the same moments as Make rep), write the coaching point -
 * then Teach it, full screen: the play moving to that moment, "Watch again",
 * the man ringed, the point beside it. Nothing is saved to PEIRA and nothing
 * is sent - it is the play, taught.
 */
export function TeachPlay({ play, onClose }: { play: Play; onClose: () => void }) {
  const [who, setWho] = useState<string | null>(null)
  const [role, setRole] = useState('')
  const [motion, setMotion] = useState(() => hasMotion(play))
  const [routes, setRoutes] = useState(false)
  const [moment, setMoment] = useState<DecisionMoment>('snap')
  const [notes, setNotes] = useState(() => readNotes(play.id))
  const [teaching, setTeaching] = useState(false)
  const preview = useRef<HTMLCanvasElement>(null)
  const moments = useMemo(() => momentsFor(play), [play])
  const clip = useMemo(() => (motion ? presnapOf(play, who, moment) : null), [play, who, motion, moment])

  useEffect(() => {
    const canvas = preview.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.setTransform(canvas.width / IMAGE_WIDTH, 0, 0, canvas.height / IMAGE_HEIGHT, 0, 0)
    drawPlay(ctx, play, { routes, motion, highlight: who })
  }, [play, routes, motion, who])

  const tapPicture = (e: MouseEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    if (!box.width || !box.height) return
    const id = playerAt(play, { x: ((e.clientX - box.left) / box.width) * IMAGE_WIDTH, y: ((e.clientY - box.top) / box.height) * IMAGE_HEIGHT })
    if (!id) return
    if (id === who) {
      setWho(null)
      setRole('')
      return
    }
    setWho(id)
    setRole(roleName(play.players.find((p) => p.id === id)!))
  }

  /** No motion to run: the play drawn still - routes if asked, the man ringed. */
  const drawn = useMemo<DrawnStill>(
    () => ({ width: IMAGE_WIDTH, height: IMAGE_HEIGHT, draw: (ctx) => drawPlay(ctx, play, { routes, motion, highlight: who }) }),
    [play, routes, motion, who],
  )
  const slide: TeachSlide = {
    key: `${play.id}-${moment}-${who ?? 'all'}-${routes}`,
    imageUrl: null,
    role: who ? role.trim() || null : null,
    prompt: notes.trim(),
    right: [],
    why: null,
    wrong: null,
    // Already in Motion Lab: no "open the play" link back to it.
    motionPlayId: null,
    picture: <PlayPicture presnap={clip} drawn={drawn} motionKey={`${play.id}-${moment}-${who}`} alt={play.name || 'The play'} />,
  }

  const teach = () => {
    writeNotes(play.id, notes)
    setTeaching(true)
  }

  return (
    <>
      <div className="popover make-q-pop make-rep-pop" role="dialog" aria-label="Teach this play" onKeyDown={(e) => e.stopPropagation()}>
        <div className="pop-title">Teach it: put the play on the big screen</div>
        <canvas
          ref={preview}
          className="make-q-preview tappable"
          width={344}
          height={180}
          aria-label="The play - tap the man to watch"
          onClick={tapPicture}
        />
        <div className="make-q-check-row">
          <label className="make-q-check">
            <input type="checkbox" checked={motion} onChange={(e) => setMotion(e.target.checked)} /> Show motion
          </label>
          <label className="make-q-check">
            <input type="checkbox" checked={routes} onChange={(e) => setRoutes(e.target.checked)} /> Show routes
          </label>
        </div>
        <MomentPicker moments={motion ? moments : []} value={moment} onChange={setMoment} clip={clip} />
        {who && (
          <label className="make-q-field">
            <span>You&rsquo;re the… (tap him again to clear)</span>
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Boundary safety" maxLength={60} />
          </label>
        )}
        <label className="make-q-field">
          <span>The coaching point</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="#3 motions across - you rotate down. Eyes on the motion man, not the QB."
            rows={3}
            maxLength={600}
          />
        </label>
        <div className="make-q-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={teach}>
            Teach it
          </button>
        </div>
      </div>
      {teaching && <TeachView title={play.name.trim() || 'The play'} slides={[slide]} onClose={() => setTeaching(false)} />}
    </>
  )
}
