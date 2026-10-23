import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { PlayPicture, type DrawnStill } from '../components/football/PlayPicture'
import { TeachView, type TeachSlide } from '../components/teach/TeachView'
import { rememberTaught } from './taughtMemory'
import { getMadeFromPlay, type MadeFromPlay } from '../api/reps'
import { readRepMemory } from './playRep'
import { CheckThem } from './CheckThem'
import checkStyles from './CheckThem.module.css'
import { Preview3DOverlay } from './Preview3DOverlay'
import type { DraftPayload, PreviewTarget, ViewerPayload } from './viewIn3D'
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
 *
 * WHAT PEIRA ALREADY KNOWS, it starts from: the man selected on the field is
 * the man to watch; the coaching point is the one he wrote for this play
 * (here, or as the "why" of a question or Rep made from it); the concept is
 * the one he named for it. All starting values, all his.
 *
 * AFTER TEACHING: Check them - what is already made from the play, or make
 * the check from this football (a Rep, a quiz question) with the man already
 * chosen. And, where a 3D viewer is set up, the same play in 3D ("Back to
 * Teach" returns to it).
 */
export function TeachPlay({
  play,
  onClose,
  selectedMan = null,
  motionPlayId = null,
  onCheck,
  preview3d = null,
}: {
  play: Play
  onClose: () => void
  /** The man selected on the field when the coach asked: he is the man to watch. */
  selectedMan?: string | null
  /** The saved play (what is made from it, what he said last time). */
  motionPlayId?: number | null
  /** Check them: make a Rep or a quiz question from this play, for this man. */
  onCheck?: (kind: 'rep' | 'question', man: string | null) => void
  /** The 3D viewer, when one is set up: the same play, from Motion Lab's own handoff. */
  preview3d?: { viewerUrl: string; target: PreviewTarget; load: () => Promise<ViewerPayload | DraftPayload> } | null
}) {
  const [start] = useState(() => {
    const man = selectedMan ? play.players.find((p) => p.id === selectedMan) : undefined
    return man ? { who: man.id, role: roleName(man) } : { who: null, role: '' }
  })
  const [who, setWho] = useState<string | null>(start.who)
  const [role, setRole] = useState(start.role)
  const [motion, setMotion] = useState(() => hasMotion(play))
  const [routes, setRoutes] = useState(false)
  const [moment, setMoment] = useState<DecisionMoment>('snap')
  const [notes, setNotes] = useState(() => readNotes(play.id))
  const notesTyped = useRef(false)
  const [teaching, setTeaching] = useState(false)
  const [show3d, setShow3d] = useState(false)
  const [made, setMade] = useState<MadeFromPlay[]>([])
  const [memory] = useState(() => readRepMemory())
  const [concept, setConcept] = useState<string | null>(() => (memory?.playId === play.id && memory.concept ? memory.concept : null))
  useEffect(() => {
    if (motionPlayId === null) return
    let live = true
    getMadeFromPlay(motionPlayId)
      .then(({ made: list, last }) => {
        if (!live) return
        setMade(list)
        if (last?.concept) setConcept((now) => now ?? last.concept!.name)
        // His point for this play, as he wrote it on a question or Rep - when
        // he has none here yet.
        if (last?.answer_explanation && !notesTyped.current) setNotes((now) => now || last.answer_explanation!)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [motionPlayId])
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
    concept,
    picture: <PlayPicture presnap={clip} drawn={drawn} motionKey={`${play.id}-${moment}-${who}`} alt={play.name || 'The play'} />,
  }

  const teach = () => {
    writeNotes(play.id, notes)
    rememberTaught(play.id)
    setTeaching(true)
  }

  return (
    <>
      <div className="popover make-q-pop make-rep-pop" role="dialog" aria-label="Teach this play" onKeyDown={(e) => e.stopPropagation()}>
        <div className="pop-title">Teach a moment: the play on the big screen</div>
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
            onChange={(e) => {
              notesTyped.current = true
              setNotes(e.target.value)
            }}
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
      {teaching && !show3d && (
        <TeachView
          title={play.name.trim() || 'The play'}
          slides={[slide]}
          onClose={() => setTeaching(false)}
          action={
            <span className={checkStyles.wrap}>
              {preview3d && (
                <button type="button" className={checkStyles.view3d} onClick={() => setShow3d(true)} title="The same play in 3D">
                  3D
                </button>
              )}
              {onCheck && <CheckThem made={made} who={who ? role.trim() || null : null} onMake={(kind) => onCheck(kind, who)} />}
            </span>
          }
        />
      )}
      {/* 2D | 3D: the play in the 3D viewer, Motion Lab's own handoff; back to the 2D teaching screen. */}
      {teaching && show3d && preview3d && (
        <Preview3DOverlay
          viewerUrl={preview3d.viewerUrl}
          target={preview3d.target}
          playName={play.name.trim() || 'The play'}
          load={preview3d.load}
          onClose={() => setShow3d(false)}
          backLabel="Back to Teach"
        />
      )}
    </>
  )
}
