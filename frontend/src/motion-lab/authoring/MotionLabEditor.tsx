import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { OverheadBoard } from '../view/OverheadBoard'
import { FIELD_WIDTH, clampToField, fromView } from '../engine/field'
import { defaultSpeed, initialPlayers, type Player, type Side, type SpeedTier, type Timing } from '../engine/formation'
import { simplify, type EndBehavior, type Pt } from '../engine/geometry'
import { buildSchedule, posAt, resolveEnd } from '../engine/timeline'
import { ballTargetOf, deriveBall, isPass, projectOntoPath, THEN_KINDS, type BallAction } from '../engine/ball'
import { catchDepth, fullBallSentence } from './ballSentence'
import { FieldView } from '../view/FieldView'
import { COACH_CAMERA, playerCamera } from '../engine/perspective'
import { buildOrientation, orientationAt } from '../engine/orientation'
import { applyEngagements, type Engagement } from '../engine/interactions'
import { hashX, lineToGainY, lookFromPlayers, newId, newPlay, situationLabel, type Look, type PathFilter, type Play, type Situation } from '../engine/play'
import type { PlayRepository } from '../storage/playRepository'
import { isEditorKeystroke } from './keyboardScope'
import { inferMeetPoint, meetPointCameFromPath } from './meetPoint'
import { playerSummary } from './playerSummary'

/**
 * WHAT THE COACH IS DOING RIGHT NOW.
 *
 * This replaces the old `mode: 'move' | 'draw' | 'edit'`. The difference is
 * not the spelling: there is no longer a mode that decides what a drag MEANS.
 * The pointer's target decides - a marker moves its player, the gold route
 * handle draws his assignment - and `interaction` only records the states a
 * target cannot express on its own: drawing armed from a button or a key, a
 * stroke in flight, and anchor editing.
 *
 * The design's state model (SPEC §3.1) also lists `moving`, `dragging-anchor`,
 * `dragging-meet-point` and `picking`. Those are deliberately NOT values here:
 * `dragRef` already holds which drag is in flight (as a ref, because it is
 * read on every pointermove) and `setup` already holds which pick is running,
 * with the ids each needs. Copying them into React state would mean two
 * sources of truth for one fact, and drift between them is exactly the class
 * of bug this slice exists to remove.
 */
type Interaction = 'idle' | 'draw-armed' | 'drawing' | 'adjusting'
type View = 'overhead' | 'coach' | 'player'

/**
 * Has anyone drawn a route since this page loaded?
 *
 * The route handle pulses until the first successful draw, then stays still -
 * a discoverability hint, not application data, so it is a module variable and
 * never reaches localStorage, sessionStorage or the server. Per page load is
 * the intended lifetime. The class that reads it sits on `.app`, OUTSIDE the
 * board's SVG, so the pulse can never make the overhead markup (and the
 * snapshots that pin it) depend on the order tests run in.
 */
let drewOnce = false

/**
 * Has the coach opened the ball menu's Advanced disclosure on this page load?
 *
 * A preference about a menu, not anything about the play: it never reaches
 * localStorage, sessionStorage, the play document or the server. Same
 * reasoning, and the same mechanism, as `drewOnce` above.
 */
let advancedOpenMemo = false

// Free-draw → anchors. Tolerance is in yards; small enough that the coach's
// shape survives, large enough that hand jitter doesn't become a handle.
const ANCHOR_EPS = 0.45
const MIN_SAMPLE_GAP = 0.15
/**
 * A stroke whose pointer never got this far (yards) from where it went down
 * was a tap, not a draw (SPEC §5.4: "drawn length < 1 yd → no change").
 */
const TAP_SLOP = 1
const TAIL = 0.4
/** A catch-point click further than this from the route is ignored. */
const CATCH_PICK_RADIUS = 3
/** How long the resting hint stays gold when D has nobody to draw for (§12.1). */
const HINT_FLASH = 200
/** Autosave and undo-grouping quiet periods. */
const SAVE_DEBOUNCE = 400
const HISTORY_DEBOUNCE = 350
const HISTORY_MAX = 60

// The ball setup flow: a short sequence of picks on the field. Each step
// says what the coach is being asked for; the field highlights the answers.
type Setup =
  | { step: 'pick-carrier'; kind: 'handoff' | 'pitch'; then?: boolean }
  | { step: 'pick-fake' }
  | { step: 'pick-target'; fakeId?: string; then?: boolean }
  | { step: 'pick-catch'; fakeId?: string; targetId: string; then?: boolean }
  | { step: 'pick-release'; targetId: string }
  | { step: 'pick-partner'; forId: string; changing?: string }
  | { step: 'pick-engage-point'; forId: string; partnerId: string }
  | { step: 'copy-to'; sourceId: string; mirror: boolean }

/** Steps that ask for a point on somebody's path. */
type PathPick = Extract<Setup, { step: 'pick-catch' | 'pick-release' }>

/** SPEC §11.1's words, sentence case (ML-UX-12). Only the labels: the stored
 *  values and the summary's own "pre-snap" are unchanged. */
const TIMINGS: { value: Timing; label: string }[] = [
  { value: 'pre-snap', label: 'Pre-snap' },
  { value: 'on-snap', label: 'On snap' },
  { value: 'delayed', label: 'Delayed' },
]
const SPEEDS: { value: SpeedTier; label: string }[] = [
  { value: 'controlled', label: 'Controlled' },
  { value: 'normal', label: 'Normal' },
  { value: 'fast', label: 'Fast' },
]
const FILTERS: { value: PathFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'offense', label: 'Offense' },
  { value: 'defense', label: 'Defense' },
  { value: 'none', label: 'None' },
]
const RATES = [0.5, 1, 1.5]
/** The five things that can happen with the ball, in the design's order (§6.3).
 *  `long` is the invitation shown when nothing is set; `short` is the same
 *  choice offered as a change to something that already exists. */
const BALL_CHOICES: { kind: BallAction['kind']; long: string; short: string }[] = [
  { kind: 'keep', long: 'QB keeps it', short: 'QB keeps it' },
  { kind: 'handoff', long: 'Handoff to…', short: 'Handoff to…' },
  { kind: 'pitch', long: 'Pitch to…', short: 'Pitch to…' },
  { kind: 'pass', long: 'Pass to…', short: 'Pass to…' },
  { kind: 'play-action', long: 'Play action: fake, then pass…', short: 'Play action…' },
]
const VIEWS: { value: View; label: string }[] = [
  { value: 'overhead', label: 'Overhead' },
  { value: 'coach', label: 'Coach' },
  { value: 'player', label: 'Player' },
]
const HASHES: { value: Situation['hash']; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'middle', label: 'Middle' },
  { value: 'right', label: 'Right' },
]

interface DragState {
  kind: 'player' | 'anchor' | 'engage'
  id: string
  index: number
  dx: number
  dy: number
}

/** The authoring state a play is made of; what autosave writes and undo restores. */
interface Authoring {
  players: Player[]
  ball: BallAction | null
  ballThen: BallAction | null
  engagements: Engagement[]
  situation: Situation
}

function Seg<T extends string | number>({
  value,
  options,
  onChange,
  size,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  size?: 'sm'
}) {
  return (
    <div className={`seg${size ? ' seg-sm' : ''}`}>
      {options.map((o) => (
        <button key={String(o.value)} className={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A text field that commits on Enter/blur and cancels on Escape. */
function InlineName({ value, onCommit, onCancel, placeholder }: { value: string; onCommit: (v: string) => void; onCancel: () => void; placeholder?: string }) {
  const [v, setV] = useState(value)
  return (
    <input
      className="inline-name"
      autoFocus
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit(v.trim() || value)
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => onCommit(v.trim() || value)}
    />
  )
}

const fmtWhen = (t: number) => {
  const d = new Date(t)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * The validated Motion Lab prototype's editor (its App.tsx), moved into PEIRA.
 *
 * `repository` is the ONLY way it reaches storage. Pass one stable instance
 * for the editor's lifetime: a different instance means a different library,
 * so the editor reloads from it.
 *
 * `exit` is rendered at the start of the top bar - PEIRA's way back out. The
 * prototype had nowhere to go back to.
 *
 * `saveStatus` replaces the built-in "Saved" indicator when the repository
 * saves over a network (P2): a synchronous repository can only report that a
 * save was accepted locally, not that it reached the server. `notice` is shown
 * over the field, for things the coach must decide (an edit conflict).
 *
 * `saveStatus` may be a function, and the page's is (ML-UX-6). The editor calls
 * it with `editPending`: true from an edit until the editor hands the play to
 * the repository - the 400 ms quiet period, which only the editor knows about.
 * Without it the page's indicator said "Saved" for the whole of that window,
 * because the repository had not yet been told anything had changed.
 */
export function MotionLabEditor({
  repository,
  exit,
  saveStatus,
  notice,
}: {
  repository: PlayRepository
  exit?: ReactNode
  saveStatus?: ReactNode | ((editor: { editPending: boolean }) => ReactNode)
  notice?: ReactNode
}) {
  // ---- the play (coach intent) ----------------------------------------
  const [playId, setPlayId] = useState<string>('')
  const [playName, setPlayName] = useState('Untitled Play')
  const [players, setPlayers] = useState<Player[]>(initialPlayers)
  const [ball, setBall] = useState<BallAction | null>(null)
  /** Optional second football action, run from whoever has it after the first. */
  const [ballThen, setBallThen] = useState<BallAction | null>(null)
  /** Coach-authored player-to-player interactions. */
  const [engagements, setEngagements] = useState<Engagement[]>([])
  const [situation, setSituation] = useState<Situation>(() => newPlay().situation)
  const [filter, setFilter] = useState<PathFilter>('all')

  // ---- library ---------------------------------------------------------
  const [plays, setPlays] = useState<Play[]>([])
  const [looks, setLooks] = useState<Look[]>([])
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  /**
   * ML-UX-6 (SPEC §3.3). True from the first edit until the write lands: the
   * whole 400 ms quiet period AND the write itself. Without it the indicator
   * said "Saved" throughout the quiet period - the one window in which the
   * edit had NOT been saved and would be lost if the tab died.
   *
   * Editor state only; it never reaches the play. When the page supplies
   * `saveStatus` as a function, this is handed to it as `editPending`, and
   * the page's session decides everything after the handoff - the network
   * write, "Saved", and every failure.
   */
  const [saving, setSaving] = useState(false)
  const loadedRef = useRef(false)

  // ---- authoring UI ----------------------------------------------------
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [interaction, setInteraction] = useState<Interaction>('idle')
  /** Mirrors `drewOnce` so the first draw re-renders the board and stops the pulse. */
  const [pulseHandle, setPulseHandle] = useState(!drewOnce)
  /** Mirrors `advancedOpenMemo` so opening the disclosure re-renders the menu. */
  const [advancedOpen, setAdvancedOpen] = useState(advancedOpenMemo)
  const [draft, setDraft] = useState<Pt[] | null>(null)
  /**
   * A drag is in progress - a player, an anchor or a block's × (ML-UX-9,
   * SPEC §5.3's `moving`). The board's cursor and the route handle's
   * visibility read it. It is set and cleared on exactly the lines `dragRef`
   * is, so it cannot outlive or precede the drag itself; `dragRef` stays the
   * drag's source of truth.
   */
  const [dragging, setDragging] = useState(false)
  const [setup, setSetup] = useState<Setup | null>(null)
  const [menuOpen, setMenuOpen] = useState<null | 'ball' | 'play' | 'situation' | 'more' | 'formation' | 'block' | 'viewer' | 'rate' | 'display'>(null)
  const [hoverCatch, setHoverCatch] = useState<Pt | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<null | 'play' | 'player' | 'look'>(null)
  const [showLabels, setShowLabels] = useState(true)

  // ---- playback / views ------------------------------------------------
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [view, setView] = useState<View>('overhead')
  /** Whose eyes the Player view uses. */
  const [viewerId, setViewerId] = useState<string | null>(null)
  const [present, setPresent] = useState(false)
  /** Teaching marks drawn in Present mode. Field yards; never saved; never touch the play. */
  const [strokes, setStrokes] = useState<Pt[][]>([])
  const [telestrating, setTelestrating] = useState(false)
  const teleDraftRef = useRef<Pt[] | null>(null)
  const [teleDraft, setTeleDraft] = useState<Pt[] | null>(null)

  const svgRef = useRef<SVGSVGElement>(null)
  const appRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const draftRef = useRef<Pt[] | null>(null)
  /**
   * Whose assignment the stroke in flight belongs to.
   *
   * Held beside the draft rather than read back from `selectedId` at commit
   * time: an armed stroke that starts on a DIFFERENT man re-targets to him,
   * and the commit must reach that man whether or not React has flushed the
   * selection yet.
   */
  const drawTargetRef = useRef<string | null>(null)
  /**
   * Was drawing armed when the stroke in flight went down? A tap is not a
   * draw, so it hands back the state it interrupted rather than disarming.
   */
  const armedAtPressRef = useRef(false)
  const rafRef = useRef(0)
  const lastTsRef = useRef(0)

  // ---- undo / redo -----------------------------------------------------
  // Snapshots of the authoring state, grouped by a short quiet period so a
  // drag is one step, not two hundred.
  const historyRef = useRef<{ stack: string[]; idx: number }>({ stack: [], idx: -1 })
  const [historyTick, setHistoryTick] = useState(0)
  const authoring: Authoring = useMemo(() => ({ players, ball, ballThen, engagements, situation }), [players, ball, ballThen, engagements, situation])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600)
  }, [])

  /**
   * D WITH NOBODY SELECTED (SPEC §12.1, ML-UX-11). The key does nothing, and
   * the resting hint - whatever it says right now - turns gold for 200 ms, so
   * the eye goes to the sentence that says what to do first. A colour state
   * set and cleared here, not an animation: reduced motion sees it too. Each
   * press starts the 200 ms over. Not authoring state: no save, no history.
   */
  const [hintFlash, setHintFlash] = useState(false)
  const hintFlashTimer = useRef<number | undefined>(undefined)
  const flashHint = useCallback(() => {
    window.clearTimeout(hintFlashTimer.current)
    setHintFlash(true)
    hintFlashTimer.current = window.setTimeout(() => setHintFlash(false), HINT_FLASH)
  }, [])
  useEffect(() => () => window.clearTimeout(hintFlashTimer.current), [])

  const applyAuthoring = useCallback((a: Authoring) => {
    setPlayers(a.players)
    setBall(a.ball)
    setBallThen(a.ballThen)
    setEngagements(a.engagements)
    setSituation(a.situation)
  }, [])

  const undo = useCallback(() => {
    const h = historyRef.current
    if (h.idx <= 0) return
    h.idx -= 1
    applyAuthoring(JSON.parse(h.stack[h.idx]) as Authoring)
    setHistoryTick((t) => t + 1)
  }, [applyAuthoring])
  const redo = useCallback(() => {
    const h = historyRef.current
    if (h.idx >= h.stack.length - 1) return
    h.idx += 1
    applyAuthoring(JSON.parse(h.stack[h.idx]) as Authoring)
    setHistoryTick((t) => t + 1)
  }, [applyAuthoring])
  const canUndo = historyRef.current.idx > 0
  const canRedo = historyRef.current.idx < historyRef.current.stack.length - 1

  useEffect(() => {
    if (!loadedRef.current) return
    const snap = JSON.stringify(authoring)
    const h = historyRef.current
    if (h.stack[h.idx] === snap) return
    const id = setTimeout(() => {
      const h = historyRef.current
      if (h.stack[h.idx] === snap) return
      h.stack = h.stack.slice(0, h.idx + 1)
      h.stack.push(snap)
      if (h.stack.length > HISTORY_MAX) h.stack.shift()
      h.idx = h.stack.length - 1
      setHistoryTick((t) => t + 1)
    }, HISTORY_DEBOUNCE)
    return () => clearTimeout(id)
  }, [authoring])
  void historyTick

  // ---- load, open, save ------------------------------------------------

  const openPlay = useCallback(
    (p: Play) => {
      setPlayId(p.id)
      setPlayName(p.name)
      applyAuthoring({ players: p.players, ball: p.ball, ballThen: p.ballThen, engagements: p.engagements, situation: p.situation })
      setFilter(p.filter)
      historyRef.current = { stack: [JSON.stringify({ players: p.players, ball: p.ball, ballThen: p.ballThen, engagements: p.engagements, situation: p.situation })], idx: 0 }
      setHistoryTick((t) => t + 1)
      setSelectedId(null)
      setSetup(null)
      setInteraction('idle')
      setMenuOpen(null)
      setRenaming(null)
      setPlaying(false)
      setTime(0)
      setStrokes([])
      repository.setCurrentPlayId(p.id)
    },
    [applyAuthoring, repository],
  )

  useEffect(() => {
    const list = repository.listPlays()
    setLooks(repository.listLooks())
    const current = repository.currentPlayId()
    const first = (current && list.find((p) => p.id === current)) || list[0] || newPlay()
    if (!list.some((p) => p.id === first.id)) repository.savePlay(first)
    setPlays(repository.listPlays())
    skipSaveRef.current = true
    openPlay(first)
    loadedRef.current = true
    if (!repository.available()) showToast('Browser storage is unavailable — plays will not persist.')
  }, [openPlay, showToast, repository])

  // Autosave: the play writes itself shortly after every edit.
  const currentPlay = useCallback(
    (): Play => ({
      v: 1,
      id: playId,
      name: playName,
      createdAt: plays.find((p) => p.id === playId)?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      players,
      ball,
      ballThen,
      engagements,
      situation,
      filter,
    }),
    [playId, playName, plays, players, ball, ballThen, engagements, situation, filter],
  )
  // The latest play is always reachable from a ref so a save can be forced
  // at any moment - before switching plays, and when the tab goes away.
  // Without that, an edit made inside the quiet period would be lost.
  const latestRef = useRef(currentPlay)
  latestRef.current = currentPlay
  const dirtyRef = useRef(false)
  const skipSaveRef = useRef(false)
  const flushSave = useCallback(() => {
    if (!dirtyRef.current) return
    dirtyRef.current = false
    const ok = repository.savePlay(latestRef.current())
    setSaving(false)
    setSaveFailed(!ok)
    if (ok) {
      setSavedAt(Date.now())
      setPlays(repository.listPlays())
    }
  }, [repository])
  useEffect(() => {
    if (!loadedRef.current || !playId) return
    // Opening a play is not an edit; it must not bump "last edited".
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    dirtyRef.current = true
    // Set with `dirty`, cleared with it in flushSave - so "Saving…" is on
    // screen exactly while there is something unsaved. Opening a play returns
    // above, before this, so opening never reads as saving.
    setSaving(true)
    const id = setTimeout(flushSave, SAVE_DEBOUNCE)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playId, playName, players, ball, ballThen, engagements, situation, filter])
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushSave()
    }
    window.addEventListener('beforeunload', flushSave)
    window.addEventListener('pagehide', flushSave)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('beforeunload', flushSave)
      window.removeEventListener('pagehide', flushSave)
      document.removeEventListener('visibilitychange', onHide)
      // INTEGRATION: inside PEIRA the editor can also go away without the
      // page going away - the coach navigates back into the app. No
      // pagehide fires for that, so the pending edit is flushed here.
      flushSave()
    }
  }, [flushSave])

  /** Leave the current play with nothing unsaved, then open another. */
  const switchTo = (p: Play) => {
    flushSave()
    skipSaveRef.current = true
    openPlay(p)
  }
  const createPlay = (fromPlayers: Player[], name = 'Untitled Play') => {
    // A new play keeps the current look (alignment, no assignments) - a
    // coach rarely wants 22 men back at the default.
    const p = newPlay(name, fromPlayers)
    repository.savePlay(p)
    setPlays(repository.listPlays())
    switchTo(p)
  }
  const duplicatePlay = () => {
    flushSave()
    const p: Play = { ...latestRef.current(), id: newId('play_'), name: `${playName} (copy)`, createdAt: Date.now(), updatedAt: Date.now() }
    repository.savePlay(p)
    setPlays(repository.listPlays())
    switchTo(p)
    setRenaming('play')
  }
  const deletePlay = () => {
    if (!window.confirm(`Delete "${playName}"? This cannot be undone.`)) return
    // Whatever was pending for this play dies with it.
    dirtyRef.current = false
    repository.deletePlay(playId)
    const rest = repository.listPlays()
    setPlays(rest)
    if (rest[0]) switchTo(rest[0])
    else createPlay(players)
  }

  const saveLook = (name: string) => {
    const l = lookFromPlayers(name, players)
    repository.saveLook(l)
    setLooks(repository.listLooks())
    showToast(`Formation "${name}" saved.`)
  }
  const loadLook = (l: Look) => {
    // Replacing the men on the field invalidates anything that named them.
    setPlayers(l.players.map((p) => ({ ...p, path: [] })))
    setBall(null)
    setBallThen(null)
    setEngagements([])
    setSelectedId(null)
    reset()
    showToast(`Formation "${l.name}" loaded — assignments and the ball were cleared.`)
  }
  const deleteLook = (l: Look) => {
    if (!window.confirm(`Delete formation "${l.name}"?`)) return
    repository.deleteLook(l.id)
    setLooks(repository.listLooks())
  }

  // ---- derived playback data ------------------------------------------

  const { schedule, drawnSchedule, snapAt, duration, ballTimeline, engaged } = useMemo(() => {
    const built = buildSchedule(players)
    // Engagements cut and pace the two players' paths so they meet; the
    // ball is then planned on the schedule the players actually run.
    const eng = applyEngagements(built.schedule, players, engagements, built.snapAt)
    const drawnSchedule = eng.schedule
    const ballTimeline = deriveBall(players, drawnSchedule, built.snapAt, ball, ballThen)
    // The play runs on the schedule the ball ran on - it may carry a
    // receiver a little past his drawn route. Both views read this one.
    const schedule = ballTimeline.schedule
    let playersEnd = built.snapAt
    for (const s of drawnSchedule.values()) playersEnd = Math.max(playersEnd, s.end)
    for (const d of eng.derived) if (d.time !== null) playersEnd = Math.max(playersEnd, d.time + 0.6)
    const hasAnything = schedule.size > 0 || ball !== null
    const duration = hasAnything ? Math.max(playersEnd, ballTimeline.end) + TAIL : 0
    return { schedule, drawnSchedule, snapAt: built.snapAt, duration, ballTimeline, engaged: eng.derived }
  }, [players, ball, ballThen, engagements])

  const positionAt = useCallback((p: Player, t: number): Pt => posAt(schedule, p, t), [schedule])

  // How everyone is turned and where they are LOOKING, frozen per schedule
  // so scrubbing is stable.
  const orientation = useMemo(() => {
    // Engaged pairs square up on each other from the moment they meet.
    const pairs = new Map<string, { partnerId: string; time: number; until?: number }>()
    for (const d of engaged) {
      if (!d.valid || d.time === null) continue
      pairs.set(d.a, { partnerId: d.b, time: d.time, until: d.until ?? undefined })
      pairs.set(d.b, { partnerId: d.a, time: d.time, until: d.until ?? undefined })
    }
    return buildOrientation(players, schedule, snapAt, duration + 1, ballTimeline.at, [ballTargetOf(ball), ballTargetOf(ballThen)].filter((x): x is string => !!x), pairs)
  }, [players, schedule, snapAt, duration, ballTimeline, ball, ballThen, engaged])
  const orientNow = useMemo(() => new Map(players.map((p) => [p.id, orientationAt(orientation, p, time)])), [players, orientation, time])

  // "I clicked here, the ball arrives there": say so briefly whenever the
  // adjusted catch changes, then get out of the way.
  const adjustedKey = ballTimeline.catchAdjusted ? `${ballTimeline.catchPoint!.x.toFixed(1)},${ballTimeline.catchPoint!.y.toFixed(1)}` : ''
  useEffect(() => {
    if (!adjustedKey) return
    setToast('Catch adjusted for timing')
    const id = setTimeout(() => setToast(null), 2600)
    return () => clearTimeout(id)
  }, [adjustedKey])
  const ballFrame = useMemo(() => ballTimeline.at(time), [ballTimeline, time])

  // ---- animation loop -------------------------------------------------

  useEffect(() => {
    if (!playing) return
    lastTsRef.current = performance.now()
    const tick = (ts: number) => {
      const dt = ((ts - lastTsRef.current) / 1000) * rate
      lastTsRef.current = ts
      setTime((t) => {
        const next = t + dt
        if (next >= duration) {
          setPlaying(false)
          return duration
        }
        return next
      })
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafRef.current)
  }, [playing, duration, rate])

  const reset = useCallback(() => {
    setPlaying(false)
    setTime(0)
  }, [])

  const togglePlay = useCallback(() => {
    if (duration === 0) return
    if (playing) {
      setPlaying(false)
      return
    }
    if (time >= duration) setTime(0)
    setPlaying(true)
  }, [duration, playing, time])

  /**
   * The dock's one transport reset (⟲), and what R does.
   *
   * Back to the spot, CARRYING ON AS YOU WERE: stopped stays stopped, playing
   * keeps playing, so a coach showing a play to a room can start it over
   * without the field going still first. It used to be two buttons - Reset
   * (stop at 0) and Restart (play from 0) - and a coach had to know which.
   *
   * This is the BUTTON's meaning only. `reset()` above is a different thing
   * that happens to look similar: the rule that any edit returns the board to
   * pre-snap. Every editing path still calls that one.
   */
  const restart = useCallback(() => {
    if (duration === 0) return
    setTime(0)
  }, [duration])

  /**
   * Step the clock by a fixed amount, for picking a frame apart.
   *
   * Stepping is looking, not watching, so it pauses first - otherwise the
   * playback loop would move the clock back out from under the coach. Clamped
   * to the play, and rounded, because 0.1 added ten times is not 1 in binary.
   */
  const step = useCallback(
    (by: number) => {
      if (duration === 0) return
      setPlaying(false)
      setTime((t) => Math.max(0, Math.min(duration, Number((t + by).toFixed(3)))))
    },
    [duration],
  )

  /**
   * Run a toolbar button's action and take the focus ring off it.
   *
   * Without this, the button a coach just clicked keeps focus and Space - the
   * play/pause key - would also activate it again.
   */
  const clicked = (fn: () => void) => (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur()
    fn()
  }

  // ---- player edits ---------------------------------------------------

  /**
   * Stop drawing without committing anything.
   *
   * A stroke in flight is thrown away and the player's previous assignment is
   * left exactly as it was: an interrupted draw must never half-write a route.
   * Safe to call in any state, so every "something else is happening now" path
   * - Esc, a menu, a view change, Present, undo, the window losing focus -
   * can call it without first asking what the coach was doing.
   *
   * Pointer capture is not released here because it cannot be: releasing needs
   * the pointerId, and a cancel can arrive from a key or the window. It does
   * not need to be. With the draft gone the later pointermove and pointerup do
   * nothing, and the browser releases capture implicitly on pointerup.
   */
  const cancelDrawing = useCallback(() => {
    draftRef.current = null
    drawTargetRef.current = null
    setDraft(null)
    setInteraction((i) => (i === 'draw-armed' || i === 'drawing' ? 'idle' : i))
  }, [])

  /**
   * Arm drawing for the selected player: the next drag on the field draws.
   *
   * The one way in that is not a gesture, shared by D and the Draw assignment
   * button so the two cannot drift. Editing happens at pre-snap, so the clock
   * goes back to the spot; a menu and anchor editing both stand down.
   */
  const armDrawing = useCallback(() => {
    setMenuOpen(null)
    reset()
    setInteraction('draw-armed')
  }, [reset])

  const updatePlayer = useCallback((id: string | null, patch: Partial<Player>) => {
    if (!id) return
    setPlayers((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }, [])

  const clearPath = useCallback(
    (id: string | null) => {
      updatePlayer(id, { path: [] })
      setInteraction((i) => (i === 'adjusting' ? 'idle' : i))
    },
    [updatePlayer],
  )

  const clearAllPaths = useCallback(() => {
    setPlayers((ps) => ps.map((p) => ({ ...p, path: [] })))
    setInteraction((i) => (i === 'adjusting' ? 'idle' : i))
  }, [])

  const qbId = players.find((p) => p.side === 'offense' && p.label === 'QB')?.id
  /**
   * Who can take the ball from the QB - handoff, pitch, pass, play action
   * (SPEC §6.4): an offensive player who is not the QB. The ball picks and
   * the ball menu ask this same question, so they cannot disagree.
   */
  const ballEligible = (p: Player) => p.side === 'offense' && p.id !== qbId
  const anyBallEligible = players.some(ballEligible)

  const addPlayer = (side: Side) => {
    const n = players.filter((p) => p.side === side).length
    const label = side === 'offense' ? 'WR' : 'DB'
    const p: Player = {
      id: newId(side === 'offense' ? 'o' : 'd'),
      side,
      label,
      x: Math.min(FIELD_WIDTH - 2, 6 + ((n * 4) % 44)),
      y: side === 'offense' ? -8 : 9,
      path: [],
      timing: 'on-snap',
      delay: 0.5,
      speed: defaultSpeed(label),
    }
    setPlayers((ps) => [...ps, p])
    setSelectedId(p.id)
    setMenuOpen(null)
    setRenaming('player')
  }

  /** Remove a man and everything that named him - never leave a dangling reference. */
  const removePlayer = (id: string) => {
    const label = players.find((p) => p.id === id)?.label ?? '?'
    setPlayers((ps) => ps.filter((p) => p.id !== id))
    const names = (a: BallAction | null) => (a ? ('carrierId' in a && a.carrierId === id) || ('targetId' in a && a.targetId === id) || ('fakeId' in a && a.fakeId === id) : false)
    const dropped: string[] = []
    if (names(ball)) {
      setBall(null)
      setBallThen(null)
      dropped.push('ball action')
    } else if (names(ballThen)) {
      setBallThen(null)
      dropped.push('second action')
    }
    if (engagements.some((e) => e.a === id || e.b === id)) {
      setEngagements((es) => es.filter((e) => e.a !== id && e.b !== id))
      dropped.push('engagement')
    }
    if (selectedId === id) setSelectedId(null)
    if (viewerId === id) setViewerId(null)
    setMenuOpen(null)
    showToast(dropped.length ? `${label} removed — his ${dropped.join(' and ')} went with him.` : `${label} removed.`)
  }

  /** The same movement, relative to HIS alignment; mirrored across his own centre if asked. */
  const copyAssignment = (sourceId: string, targetId: string, mirror: boolean) => {
    const src = players.find((p) => p.id === sourceId)
    const dst = players.find((p) => p.id === targetId)
    if (!src || !dst || src.path.length < 2) return
    const path = src.path.map((q) => {
      const rx = q.x - src.x
      const ry = q.y - src.y
      return clampToField({ x: dst.x + (mirror ? -rx : rx), y: dst.y + ry })
    })
    updatePlayer(targetId, { path, timing: src.timing, delay: src.delay, speed: src.speed, endBehavior: src.endBehavior })
    setSelectedId(targetId)
    showToast(`${src.label}'s assignment ${mirror ? 'mirrored' : 'copied'} to ${dst.label}.`)
  }

  /** Move the whole look sideways so the ball sits on the chosen hash. */
  const setHash = (hash: Situation['hash']) => {
    const center = players.find((p) => p.side === 'offense' && p.label === 'C')
    const ol = players.filter((p) => p.side === 'offense' && ['LT', 'LG', 'C', 'RG', 'RT'].includes(p.label))
    const nowX = center ? center.x : ol.length ? ol.reduce((s, p) => s + p.x, 0) / ol.length : FIELD_WIDTH / 2
    const dx = hashX(hash) - nowX
    const shift = (q: Pt): Pt => clampToField({ x: q.x + dx, y: q.y })
    setPlayers((ps) => ps.map((p) => ({ ...p, ...shift(p), path: p.path.map(shift) })))
    setEngagements((es) => es.map((e) => ({ ...e, point: shift(e.point) })))
    const shiftBall = (b: BallAction | null): BallAction | null => (isPass(b) ? { ...b, catchPoint: shift(b.catchPoint), releasePoint: b.releasePoint ? shift(b.releasePoint) : undefined } : b)
    setBall(shiftBall)
    setBallThen(shiftBall)
    setSituation((s) => ({ ...s, hash }))
  }

  // ---- ball setup -----------------------------------------------------

  const startSetup = (kind: BallAction['kind'], then = false) => {
    setMenuOpen(null)
    cancelDrawing()
    reset()
    // SPEC §6.8: the menu is in the dock, so it opens from Coach and Player
    // view too - but every pick happens ON THE BOARD. Go there first, then
    // show the banner, rather than refusing the coach the menu he just used.
    // "QB keeps it" and "Clear the ball" need no pick and no switch; they
    // return below without reaching this.
    if (kind !== 'keep' && view !== 'overhead') {
      setView('overhead')
      setTelestrating(false)
    }
    // Changing the first action changes who ends up with the ball, so a
    // second action authored against the old carrier is cleared, not guessed.
    if (!then && ballThen) {
      setBallThen(null)
      showToast('Second action cleared — the first action changed.')
    }
    if (kind === 'keep') {
      setBall({ kind: 'keep' })
      return
    }
    setSelectedId(null)
    setSetup(
      kind === 'handoff' || kind === 'pitch' ? { step: 'pick-carrier', kind, then } : kind === 'pass' ? { step: 'pick-target', then } : { step: 'pick-fake' },
    )
  }

  const cancelSetup = useCallback(() => {
    setSetup(null)
    setHoverCatch(null)
  }, [])

  const switchView = (v: View) => {
    setView(v)
    setMenuOpen(null)
    if (v !== 'overhead') {
      cancelSetup()
      cancelDrawing()
      setInteraction('idle')
      setTelestrating(false)
    }
    // Player view: the selected player is the obvious answer; otherwise the
    // last one watched; otherwise ask, right on the field.
    if (v === 'player' && selectedId) setViewerId(selectedId)
  }
  // Player view with nobody to watch from: the overhead stays up so the
  // coach can click one.
  const pickingViewer = view === 'player' && !viewerId
  const watching = view !== 'overhead' && !pickingViewer
  const viewer = viewerId ? (players.find((p) => p.id === viewerId) ?? null) : null

  const enterPresent = () => {
    cancelSetup()
    setMenuOpen(null)
    cancelDrawing()
    setInteraction('idle')
    setRenaming(null)
    setPlaying(false)
    setPresent(true)
  }
  const exitPresent = () => {
    setPresent(false)
    setTelestrating(false)
    setStrokes([])
  }

  // Who can be picked at the current step.
  const pickable = (p: Player): boolean => {
    if (pickingViewer) return true
    if (!setup) return false
    if (setup.step === 'pick-partner') {
      // SPEC §7.2: the other side, and not already in a block. A man can only
      // be in one, and a block against your own side is not a thing.
      const blocker = players.find((pl) => pl.id === setup.forId)
      if (!blocker || p.side === blocker.side) return false
      return !engagements.some((e) => (e.a === p.id || e.b === p.id) && e.id !== setup.changing)
    }
    if (setup.step === 'copy-to') return p.id !== setup.sourceId
    if (setup.step === 'pick-catch' || setup.step === 'pick-release' || setup.step === 'pick-engage-point') return false
    if ('then' in setup && setup.then) return p.side === 'offense' && p.id !== (ballTimeline.chain?.carrierId ?? qbId)
    if (!ballEligible(p)) return false
    if (setup.step === 'pick-target' && setup.fakeId === p.id) return false
    return true
  }

  const finishPass = (s: Extract<Setup, { step: 'pick-catch' }>, catchPoint: Pt) => {
    const a: BallAction = s.fakeId ? { kind: 'play-action', fakeId: s.fakeId, targetId: s.targetId, catchPoint } : { kind: 'pass', targetId: s.targetId, catchPoint }
    if (s.then) setBallThen(a)
    else setBall(a)
    setSetup(null)
    setHoverCatch(null)
  }

  const pickPlayer = (id: string) => {
    if (!setup) return
    const p = players.find((pl) => pl.id === id)!
    switch (setup.step) {
      case 'pick-carrier': {
        const a: BallAction = setup.kind === 'pitch' ? { kind: 'pitch', targetId: id } : { kind: 'handoff', carrierId: id }
        if (setup.then) setBallThen(a)
        else setBall(a)
        setSetup(null)
        break
      }
      case 'pick-fake':
        setSetup({ step: 'pick-target', fakeId: id })
        break
      case 'pick-partner': {
        // SPEC §7.3: one click. The spot is nearly always the end of the
        // blocker's path, so PEIRA fills it in and the coach corrects it only
        // when he disagrees - which is what `auto` records.
        const blocker = players.find((pl) => pl.id === setup.forId)!
        const point = inferMeetPoint(blocker, p)
        if (setup.changing) {
          // Same block, different man: the id and the release are the coach's
          // and survive. The point moves only if it was PEIRA's to move.
          setEngagements((es) =>
            es.map((x) => (x.id === setup.changing ? { ...x, b: id, point: x.auto ? point : x.point } : x)),
          )
        } else {
          setEngagements((es) => [...es, { id: newId('e'), kind: 'engage', a: setup.forId, b: id, point, auto: true }])
          showToast(
            meetPointCameFromPath(blocker)
              ? `${blocker.label} blocks ${p.label} where his path ends. Drag the × to move it.`
              : `${blocker.label} blocks ${p.label} halfway to him. Drag the × to move it, or draw ${blocker.label}'s path.`,
          )
        }
        setSelectedId(setup.forId)
        cancelSetup()
        break
      }
      case 'copy-to':
        copyAssignment(setup.sourceId, id, setup.mirror)
        setSetup(null)
        break
      case 'pick-target':
        if (schedule.has(id)) setSetup({ step: 'pick-catch', fakeId: setup.fakeId, targetId: id, then: setup.then })
        else {
          // A receiver with no route is caught where they stand - nothing to
          // pick. Say so, because the coach asked for a catch point and did
          // not get to choose one; there is no lasting "needs a route" state.
          finishPass({ step: 'pick-catch', fakeId: setup.fakeId, targetId: id, then: setup.then }, { x: p.x, y: p.y })
          showToast(`${p.label} has no route, so he catches it where he stands. Draw his route, then set the catch point again.`)
        }
        break
    }
  }

  const projectCatch = (s: PathPick, pos: Pt): Pt | null => {
    const sch = schedule.get(s.targetId)
    if (!sch) return null
    const proj = projectOntoPath(sch.pts, sch.cum, pos)
    return proj.gap <= CATCH_PICK_RADIUS ? proj.pt : null
  }

  // ---- pointer handling -----------------------------------------------

  const toField = (e: { clientX: number; clientY: number }): Pt => {
    const svg = svgRef.current!
    const pt = new DOMPoint(e.clientX, e.clientY)
    const v = pt.matrixTransform(svg.getScreenCTM()!.inverse())
    return fromView(v.x, v.y)
  }

  const hitAttr = (target: EventTarget | null, attr: string): string | null => {
    const el = (target as Element | null)?.closest?.(`[${attr}]`)
    return el ? el.getAttribute(attr) : null
  }

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    setMenuOpen(null)
    const pos = toField(e)
    const hit = hitAttr(e.target, 'data-player')

    // Present mode: no authoring. Highlight a man, or mark the field.
    if (present) {
      if (telestrating) {
        setPlaying(false)
        teleDraftRef.current = [pos]
        setTeleDraft(teleDraftRef.current)
        svgRef.current!.setPointerCapture(e.pointerId)
        return
      }
      // Player view with nobody to watch from (ML-UX-8, owner decision):
      // Present has no strip to ask the question in, so the click answers
      // it. Without this, a coach who chose Player first was stuck - a click
      // only highlighted, and nothing ever chose a viewer.
      if (pickingViewer) {
        if (hit) setViewerId(hit)
        return
      }
      setSelectedId(hit)
      return
    }

    // Choosing whose eyes to watch from is not an edit: the clock stays put.
    if (pickingViewer) {
      if (hit) setViewerId(hit)
      return
    }

    // Any edit returns the board to pre-snap so what you see is what you edit.
    reset()

    // Ball setup picks take over the field until they finish or are cancelled.
    if (setup) {
      if (setup.step === 'pick-catch') {
        const pt = projectCatch(setup, pos)
        if (pt) finishPass(setup, pt)
      } else if (setup.step === 'pick-release') {
        const pt = projectCatch(setup, pos)
        if (pt) {
          setBall((b) => (isPass(b) ? { ...b, releasePoint: pt } : b))
          cancelSetup()
        }
      } else if (setup.step === 'pick-engage-point') {
        // The coach placing the point himself ends PEIRA's claim on it.
        const { forId, partnerId } = setup
        setEngagements((es) =>
          es.some((x) => x.a === forId && x.b === partnerId)
            ? es.map((x) => (x.a === forId && x.b === partnerId ? { ...x, point: clampToField(pos), auto: false } : x))
            : [...es, { id: newId('e'), kind: 'engage', a: forId, b: partnerId, point: clampToField(pos), auto: false }],
        )
        setSelectedId(forId)
        cancelSetup()
      } else if (hit) {
        const p = players.find((pl) => pl.id === hit)!
        if (pickable(p)) pickPlayer(hit)
      }
      return
    }

    // An engage marker drags like a handle, in any mode.
    const engId = hitAttr(e.target, 'data-engage')
    if (engId) {
      const en = engagements.find((x) => x.id === engId)!
      setSelectedId(en.a)
      dragRef.current = { kind: 'engage', id: engId, index: 0, dx: en.point.x - pos.x, dy: en.point.y - pos.y }
      setDragging(true)
      svgRef.current!.setPointerCapture(e.pointerId)
      return
    }

    // Edit Path handles sit above everything else.
    if (interaction === 'adjusting' && selectedId) {
      const idx = hitAttr(e.target, 'data-anchor')
      if (idx !== null) {
        const p = players.find((pl) => pl.id === selectedId)!
        const a = p.path[Number(idx)]
        dragRef.current = { kind: 'anchor', id: selectedId, index: Number(idx), dx: a.x - pos.x, dy: a.y - pos.y }
        setDragging(true)
        svgRef.current!.setPointerCapture(e.pointerId)
        return
      }
    }

    // THE ROUTE HANDLE, BEFORE THE MARKER IT LIVES IN.
    //
    // The handle is rendered inside its player's <g data-player> so it travels
    // with him, and `hitAttr` walks up with closest() - so a hit on the handle
    // answers to data-player too. Asking about the handle first is what makes
    // "grab the man, move him; grab his handle, draw" two different gestures
    // rather than one that always moves.
    const handleId = hitAttr(e.target, 'data-handle')

    // Drawing: from the handle, or from anywhere on the field once armed.
    //
    // Armed deliberately outranks the marker rule. A coach who has just
    // pressed D and puts the pointer down on the man he selected means to
    // draw from him, not to nudge him half a yard.
    if (handleId || interaction === 'draw-armed') {
      let startId = handleId ?? selectedId
      if (!handleId && hit) {
        startId = hit
        setSelectedId(hit)
      }
      if (!startId) return
      const start = players.find((p) => p.id === startId)!
      drawTargetRef.current = startId
      armedAtPressRef.current = interaction === 'draw-armed'
      // The path is always anchored at the player, wherever the pointer went down.
      draftRef.current = [{ x: start.x, y: start.y }, pos]
      setDraft(draftRef.current)
      setInteraction('drawing')
      svgRef.current!.setPointerCapture(e.pointerId)
      return
    }

    if (hit) {
      const p = players.find((pl) => pl.id === hit)!
      setSelectedId(hit)
      setRenaming(null)
      // Adjusting only means something for a player with a path.
      if (interaction === 'adjusting' && p.path.length < 2) setInteraction('idle')
      dragRef.current = { kind: 'player', id: hit, index: 0, dx: p.x - pos.x, dy: p.y - pos.y }
      setDragging(true)
      svgRef.current!.setPointerCapture(e.pointerId)
    } else {
      setSelectedId(null)
      setRenaming(null)
    }
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (teleDraftRef.current) {
      const pos = toField(e)
      const d = teleDraftRef.current
      const last = d[d.length - 1]
      if (Math.hypot(pos.x - last.x, pos.y - last.y) < 0.1) return
      d.push(pos)
      setTeleDraft(d.slice())
      return
    }
    if (setup?.step === 'pick-catch' || setup?.step === 'pick-release') {
      setHoverCatch(projectCatch(setup, toField(e)))
      return
    }
    const drag = dragRef.current
    if (drag) {
      const pos = toField(e)
      const next = clampToField({ x: pos.x + drag.dx, y: pos.y + drag.dy })
      if (drag.kind === 'engage') {
        // SPEC §7.4: he has moved it himself, so PEIRA stops moving it for him.
        setEngagements((es) => es.map((x) => (x.id === drag.id ? { ...x, point: next, auto: false } : x)))
        return
      }
      setPlayers((ps) =>
        ps.map((p) => {
          if (p.id !== drag.id) return p
          if (drag.kind === 'anchor') {
            const path = p.path.slice()
            path[drag.index] = next
            return { ...p, path }
          }
          // Paths travel with the player so a drawn assignment stays attached.
          const ddx = next.x - p.x
          const ddy = next.y - p.y
          return { ...p, x: next.x, y: next.y, path: p.path.map((q) => ({ x: q.x + ddx, y: q.y + ddy })) }
        }),
      )
      // A catch point is part of the receiver's assignment and a throw point
      // is part of the QB's: both move with their player.
      if (drag.kind === 'player') {
        setBall((b) => {
          if (!isPass(b)) return b
          const p = players.find((pl) => pl.id === drag.id)!
          const shift = (q: Pt): Pt => ({ x: q.x + (next.x - p.x), y: q.y + (next.y - p.y) })
          if (b.targetId === drag.id) return { ...b, catchPoint: shift(b.catchPoint) }
          if (drag.id === qbId && b.releasePoint) return { ...b, releasePoint: shift(b.releasePoint) }
          return b
        })
        setBallThen((b) => {
          if (!isPass(b) || b.targetId !== drag.id) return b
          const p = players.find((pl) => pl.id === drag.id)!
          return { ...b, catchPoint: { x: b.catchPoint.x + (next.x - p.x), y: b.catchPoint.y + (next.y - p.y) } }
        })
      }
      return
    }
    const d = draftRef.current
    if (d) {
      const pos = clampToField(toField(e))
      const last = d[d.length - 1]
      if (Math.hypot(pos.x - last.x, pos.y - last.y) < MIN_SAMPLE_GAP) return
      d.push(pos)
      setDraft(d.slice())
    }
  }

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (teleDraftRef.current) {
      const d = teleDraftRef.current
      teleDraftRef.current = null
      setTeleDraft(null)
      svgRef.current?.releasePointerCapture(e.pointerId)
      if (d.length >= 2) setStrokes((s) => [...s, d])
      return
    }
    if (dragRef.current) {
      dragRef.current = null
      setDragging(false)
      svgRef.current?.releasePointerCapture(e.pointerId)
      return
    }
    const d = draftRef.current
    if (d) {
      const drawnFor = drawTargetRef.current
      draftRef.current = null
      drawTargetRef.current = null
      setDraft(null)
      svgRef.current?.releasePointerCapture(e.pointerId)
      // A TAP IS NOT A DRAW (SPEC §5.4, §5.7). What decides it is how far
      // the POINTER got from where it went down - d[1] onward - never the
      // route's length. The route starts at the man (d[0]) and a press on
      // his handle is already 1.3-2.9 yd from him, so measuring the route
      // turned every bare tap on the handle into a short one. The press is
      // clamped only for this measurement, into the space every later
      // sample was recorded in; the route itself is untouched.
      const press = clampToField(d[1])
      const moved = Math.max(...d.slice(1).map((q) => Math.hypot(q.x - press.x, q.y - press.y)))
      if (moved < TAP_SLOP) {
        setInteraction(armedAtPressRef.current ? 'draw-armed' : 'idle')
        return
      }
      setInteraction('idle')
      updatePlayer(drawnFor, { path: simplify(d, ANCHOR_EPS) })
      // The handle has been found; it no longer needs to wave.
      drewOnce = true
      setPulseHandle(false)
    }
  }

  // ---- keyboard -------------------------------------------------------

  const selected = players.find((p) => p.id === selectedId) ?? null
  const hasPath = !!selected && selected.path.length > 1
  /** The strip's last word on him (ML-UX-7): read from state, never stored. */
  const summary = selected
    ? playerSummary({ player: selected, players, drawn: drawnSchedule.get(selected.id), engagements, derived: engaged, ball, ballThen })
    : ''

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // INTEGRATION: the shortcuts belong to the field. The prototype owned
      // the whole page and skipped only INPUT; inside PEIRA they must also
      // leave every other text control alone, and anything outside the
      // editor (a portaled PEIRA dialog, for one).
      if (!isEditorKeystroke(e.target, appRef.current)) return
      const meta = e.ctrlKey || e.metaKey
      if (meta && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (present) return
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (meta && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        if (!present) redo()
        return
      }
      if (meta) return
      switch (e.code === 'Space' ? ' ' : e.key) {
        // V is gone with the Move/Draw segment: there is no mode to go back to.
        case 'd':
        case 'D':
          if (selectedId && !setup && !watching && !present) armDrawing()
          // Nobody to draw for (SPEC §12.1): the resting hint flashes instead -
          // only where that hint is on screen, so Overhead, no pick, not Present.
          else if (!selectedId && !setup && view === 'overhead' && !present) flashHint()
          break
        case 'e':
        case 'E':
          if (hasPath && !setup && !watching && !present) {
            cancelDrawing()
            setInteraction((i) => (i === 'adjusting' ? 'idle' : 'adjusting'))
          }
          break
        case 'b':
        case 'B':
          // Coach and Player views too (SPEC §10: "not Present; not picking"):
          // the ball button works there, so its key does. A pick it leads to
          // switches back to Overhead on its own (§6.8, ML-UX-3).
          if (!setup && !present) setMenuOpen((o) => (o === 'ball' ? null : 'ball'))
          break
        case 'Escape':
          // First match wins. Drawing comes before arming, and both before
          // anything that would merely change the selection: Esc mid-stroke
          // has to reach the stroke, not the man it belongs to.
          if (menuOpen) setMenuOpen(null)
          else if (renaming) setRenaming(null)
          else if (telestrating) setTelestrating(false)
          else if (pickingViewer) setView('overhead')
          else if (setup) cancelSetup()
          else if (interaction === 'drawing' || interaction === 'draw-armed') cancelDrawing()
          else if (interaction === 'adjusting') setInteraction('idle')
          else setSelectedId(null)
          break
        case ' ':
          e.preventDefault()
          // SPEC §10: Space "cancels draw-armed or a pick first". Watching the
          // play while the field is still asking a question would leave the
          // banner up over a play in motion - and §6.5 counts Play among the
          // ways out of a pick, which must leave the ball as it was.
          if (setup) cancelSetup()
          cancelDrawing()
          togglePlay()
          break
        case 'r':
        case 'R':
          // The key the ⟲ button is labelled with, so the two agree.
          restart()
          break
        case 'ArrowLeft':
          e.preventDefault()
          step(e.shiftKey ? -0.5 : -0.1)
          break
        case 'ArrowRight':
          e.preventDefault()
          step(e.shiftKey ? 0.5 : 0.1)
          break
        case 'Delete':
        case 'Backspace':
          if (!setup && !present) clearPath(selectedId)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, hasPath, interaction, setup, menuOpen, renaming, telestrating, pickingViewer, watching, view, present, togglePlay, restart, step, reset, clearPath, cancelSetup, armDrawing, cancelDrawing, flashHint, undo, redo])

  // Leaving the selection empties arming and anchor editing of meaning.
  useEffect(() => {
    if (!selectedId && interaction !== 'idle') {
      draftRef.current = null
      drawTargetRef.current = null
      setDraft(null)
      setInteraction('idle')
    }
  }, [selectedId, interaction])

  /**
   * KEEP AN INFERRED BLOCK ON THE END OF THE BLOCKER'S PATH (SPEC §7.9).
   *
   * While `auto` is true the point is still PEIRA's guess, so it follows the
   * path it was guessed from: redraw the route and the block moves to the new
   * end; clear the route and it falls back to halfway between the two men;
   * draw one again and it returns to the end.
   *
   * ONLY THE BLOCKER'S PATH. A defender's route changing has not altered
   * where the man blocking him ends up, and moving the point then would make
   * a coach's block wander for a reason he did not cause.
   *
   * Once he has placed the point himself, `auto` is false and this leaves it
   * alone for good.
   */
  useEffect(() => {
    setEngagements((es) => {
      let changed = false
      const next = es.map((e) => {
        if (!e.auto) return e
        const blocker = players.find((p) => p.id === e.a)
        const partner = players.find((p) => p.id === e.b)
        if (!blocker || !partner) return e
        const point = inferMeetPoint(blocker, partner)
        if (point.x === e.point.x && point.y === e.point.y) return e
        changed = true
        return { ...e, point }
      })
      return changed ? next : es
    })
  }, [players])

  /**
   * A stroke must not survive the coach looking away, and nor must a drag.
   *
   * Losing focus mid-drag means the pointerup lands somewhere else and never
   * reaches us, which would leave a half-drawn route following the mouse.
   * Throw it away instead: the previous assignment is untouched.
   *
   * A drag of a man, an anchor or a block's × simply stops (ML-UX-9). It is
   * not a pointerup and commits nothing new, but it rolls nothing back
   * either: a drag writes as it goes, and whatever it had already moved
   * stays moved and saves as usual. Without this the board sat in
   * `board-moving` and the next pointermove carried the drag on.
   */
  useEffect(() => {
    const onBlur = () => {
      cancelDrawing()
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [cancelDrawing])

  // ---- render ---------------------------------------------------------

  const hasPaths = schedule.size > 0
  const canPlay = duration > 0
  const sideVisible = (side: Side) => filter === 'all' || filter === side
  const pathVisible = (p: Player) => p.id === selectedId || sideVisible(p.side)
  const catchTargetId = setup?.step === 'pick-catch' || setup?.step === 'pick-release' ? setup.targetId : null
  const name = (id: string) => players.find((p) => p.id === id)?.label ?? '?'
  const toggleMenu = (m: NonNullable<typeof menuOpen>) => setMenuOpen((o) => (o === m ? null : m))
  const lineToGain = lineToGainY(situation)
  // "Throw from here" only makes sense for a pass with a QB who actually moves.
  const qbHasPath = !!qbId && schedule.has(qbId)
  const canPickRelease = isPass(ball) && qbHasPath && !setup
  const hasReleaseOverride = isPass(ball) && !!ball.releasePoint
  const startPickRelease = () => {
    if (!qbId) return
    setMenuOpen(null)
    cancelDrawing()
    setSelectedId(null)
    reset()
    setSetup({ step: 'pick-release', targetId: qbId })
  }
  const useDefaultRelease = () => {
    setMenuOpen(null)
    setBall((b) => (isPass(b) ? { ...b, releasePoint: undefined } : b))
  }
  const startCopy = (mirror: boolean) => {
    if (!selected) return
    setMenuOpen(null)
    cancelDrawing()
    reset()
    setSetup({ step: 'copy-to', sourceId: selected.id, mirror })
  }

  // Time shown relative to the snap: "-1.2s" is pre-snap, "+0.8s" is post.
  const fmtRel = (t: number) => {
    const r = t - snapAt
    return `${r < 0 ? '−' : '+'}${Math.abs(r).toFixed(1)}s`
  }

  /**
   * Show the gold route handle?
   *
   * It is an invitation to draw, so it appears only where a drag would draw:
   * resting on a selected man, or already armed. While a stroke is in flight,
   * while anchors are being edited, and during a ball pick it would be a
   * second gold thing competing for the same pointer. And not while anything
   * is being dragged (SPEC §5.2, "hidden while moving"; the ring still moves):
   * the drag holds the pointer, so the handle could not be used anyway.
   */
  const showRouteHandle = !setup && !dragging && (interaction === 'idle' || interaction === 'draw-armed')

  /**
   * THE BOARD'S ONE STATE CLASS (ML-UX-9, SPEC §5.3): `board-idle`,
   * `board-armed`, `board-drawing`, `board-adjusting`, `board-moving`,
   * `board-picking`, `board-present` or `board-tele`. CSS reads it to set
   * every cursor; nothing sets a cursor inline.
   *
   * One at a time, in the order the states actually win: a drag in progress
   * is what the pointer is doing whatever else is true (it only ever starts
   * from idle or Adjust); Present never overlaps a pick or a drawing, since
   * entering it cancels both; a pick leaves `interaction` idle, so it has to
   * be read before it.
   */
  const boardState = dragging
    ? 'moving'
    : present
      ? telestrating
        ? 'tele'
        : 'present'
      : setup
        ? 'picking'
        : interaction === 'draw-armed'
          ? 'armed'
          : interaction

  /**
   * The drawing banner's sentence (SPEC §11.2).
   *
   * Only two states reach it now. Every other instruction this used to carry
   * moved to the place it describes: the strip says what a selected man can
   * do (ML-UX-4), the pick banners say what to click (ML-UX-3), and the
   * watching and Present sentences live in their own strip branches.
   */
  const hint =
    interaction === 'drawing' ? (
      <>Drawing <b>{selected?.label}</b>'s assignment. Let go to finish. <b>Esc</b> to cancel.</>
    ) : (
      <>Draw <b>{selected?.label}</b>'s assignment: drag on the field. <b>Esc</b> to cancel.</>
    )

  /**
   * THE WAITING SENTENCE for a field pick (SPEC §11.2).
   *
   * One sentence per step, saying what the coach is being asked for, in the
   * same banner row a drawing uses. The bold half is the instruction: a coach
   * glancing up should be able to read only the bold and know what to click.
   */
  const instruction = (() => {
    if (!setup) return null
    const carrier = () => name(ballTimeline.chain?.carrierId ?? qbId ?? '')
    switch (setup.step) {
      case 'pick-carrier':
        return setup.then ? (
          <>Then <b>{carrier()}</b> {setup.kind === 'pitch' ? 'pitches' : 'hands off'}. <b>Choose who gets it.</b></>
        ) : (
          <>{setup.kind === 'pitch' ? 'Pitch' : 'Handoff'}. <b>Choose who gets the ball.</b></>
        )
      case 'pick-fake':
        return <>Play action. <b>Choose who the QB fakes to.</b></>
      case 'pick-target':
        if (setup.fakeId) return <>Faking to <b>{name(setup.fakeId)}</b>. Now <b>choose the receiver.</b></>
        return setup.then ? (
          <>Then <b>{carrier()}</b> throws. <b>Choose the receiver.</b></>
        ) : (
          <>Pass. <b>Choose the receiver.</b></>
        )
      case 'pick-catch':
        return setup.then ? (
          <>Then <b>{carrier()}</b> throws to <b>{name(setup.targetId)}</b>. <b>Click where on his route the ball arrives.</b></>
        ) : (
          <>Pass to <b>{name(setup.targetId)}</b>. <b>Click where on his route the ball arrives.</b></>
        )
      case 'pick-release':
        return <><b>Click where on the QB's path he throws from.</b></>
      case 'pick-partner': {
        // SPEC §7.2: the word depends on who is doing it.
        const forPlayer = players.find((pl) => pl.id === setup.forId)
        return forPlayer?.side === 'offense' ? (
          <><b>Choose the defender {forPlayer.label} blocks.</b></>
        ) : (
          <><b>Choose who {name(setup.forId)} engages.</b></>
        )
      }
      case 'pick-engage-point':
        return <><b>Click where {name(setup.forId)} and {name(setup.partnerId)} meet.</b></>
      case 'copy-to':
        return <>{setup.mirror ? 'Mirror' : 'Copy'} <b>{name(setup.sourceId)}</b>'s assignment. <b>Click the player who gets it.</b></>
    }
  })()

  /**
   * WHO HE MEETS (SPEC §7.6). Strip position 5.
   *
   * Unengaged, one button: `Blocks…` for a blocker, `Engages…` for a
   * defender - disabled when there is nobody left on the other side to pick,
   * because a pick with no legal answer is a dead end.
   *
   * Engaged, the block itself: who it is against, with its menu, and whether
   * he comes off it. A red `!` in front when the engine says they cannot
   * actually get there.
   */
  const selectedEngagement = selected ? engagements.find((x) => x.a === selected.id || x.b === selected.id) ?? null : null
  const selectedDerived = selectedEngagement ? engaged.find((d) => d.id === selectedEngagement.id) ?? null : null
  const engagedWord = selected?.side === 'offense' ? 'Blocks' : 'Engages'
  /** The other side, minus anyone already spoken for (SPEC §7.2). */
  const legalPartners = selected
    ? players.filter((p) => p.side !== selected.side && !engagements.some((e) => e.a === p.id || e.b === p.id))
    : []
  const startPartnerPick = (changing?: string) => {
    if (!selected) return
    cancelDrawing()
    reset()
    setMenuOpen(null)
    setSetup({ step: 'pick-partner', forId: selected.id, changing })
  }

  const engageControls = selected ? (
    selectedEngagement ? (
      <>
        {selectedDerived?.warning && <span className="warn" title={selectedDerived.warning}>!</span>}
        <div className="ball-menu">
          <button
            className={menuOpen === 'block' ? 'active' : ''}
            onClick={() => toggleMenu('block')}
            aria-expanded={menuOpen === 'block'}
          >
            {engagedWord} {name(selectedEngagement.a === selected.id ? selectedEngagement.b : selectedEngagement.a)}{' '}
            <span className="key">▾</span>
          </button>
          {menuOpen === 'block' && (
            <div className="popover play-pop-left block-pop">
              <button onClick={() => startPartnerPick(selectedEngagement.id)}>
                {selected.side === 'offense' ? 'Change the defender…' : 'Change who he engages…'}
              </button>
              <button
                onClick={() => {
                  setMenuOpen(null)
                  cancelDrawing()
                  reset()
                  setSetup({
                    step: 'pick-engage-point',
                    forId: selectedEngagement.a,
                    partnerId: selectedEngagement.b,
                  })
                }}
              >
                Move the meeting point…
              </button>
              <button
                className="pop-clear"
                onClick={() => {
                  setMenuOpen(null)
                  setEngagements((es) => es.filter((x) => x.id !== selectedEngagement.id))
                }}
              >
                Remove the block
              </button>
            </div>
          )}
        </div>
        {/* SPEC §7.5: engage-only is the default. One release per block, so
            setting it here takes it off the other man. */}
        <button
          className={selectedEngagement.release === selected.id ? 'gold-line' : ''}
          title="Comes off after a moment and continues his own path."
          onClick={() =>
            setEngagements((es) =>
              es.map((x) =>
                x.id === selectedEngagement.id
                  ? { ...x, release: x.release === selected.id ? undefined : selected.id }
                  : x,
              ),
            )
          }
        >
          {selectedEngagement.release === selected.id ? 'Releases ✓' : 'Releases'}
        </button>
      </>
    ) : (
      <button
        disabled={legalPartners.length === 0}
        // The sentence names the side he would have picked from: a defender
        // with nobody left is out of offensive players, not defenders.
        title={
          legalPartners.length === 0
            ? selected.side === 'offense'
              ? 'Every defender is already engaged.'
              : 'Every offensive player is already engaged.'
            : undefined
        }
        onClick={() => startPartnerPick()}
      >
        {engagedWord}…
      </button>
    )
  ) : null
  // Pairs that are engaged at this instant, for the link drawn between them.
  const engagedNow = engaged
    .filter((d) => d.valid && d.time !== null && time >= d.time && (d.until === null || time < d.until))
    .map((d) => ({ id: d.id, a: positionAt(players.find((p) => p.id === d.a)!, time), b: positionAt(players.find((p) => p.id === d.b)!, time), since: time - d.time! }))

  const ballNote = ballTimeline.warning && ball ? (
    <><b>Ball:</b> {ballTimeline.warning}</>
  ) : ballTimeline.qbHold > 0.25 && ball ? (
    <><b>Ball:</b> {ballTimeline.passer} holds {ballTimeline.qbHold.toFixed(1)}s at the top of his drop for {isPass(ballThen) ? name(ballThen.targetId) : isPass(ball) ? name(ball.targetId) : ''}'s timing.</>
  ) : ballTimeline.qbEarly > 0.25 && ball ? (
    <><b>Ball:</b> {ballTimeline.passer} lets it go {ballTimeline.qbEarly.toFixed(1)}s before the top of his drop for {isPass(ballThen) ? name(ballThen.targetId) : isPass(ball) ? name(ball.targetId) : ''}'s timing.</>
  ) : null

  /**
   * THE BALL, AT THE FAR LEFT OF THE DOCK (SPEC §6.1, §6.3).
   *
   * One control that says what happens with the ball in a sentence, and opens
   * a menu that reads as a question when nothing is set and as a statement
   * once something is. It used to be a button in the top bar whose label was a
   * summary of the stored object.
   */
  const ballText = fullBallSentence(ball, ballThen, players)
  const ballWarning = ball ? ballTimeline.warning : null
  const nowDepth = catchDepth(ball)
  const canAdvanced = isPass(ball) && qbHasPath

  const ballControl = (
    <div className="ball-menu">
      <button
        className={`ball-btn${ball ? ' has-action' : ' gold-line'}${menuOpen === 'ball' ? ' active' : ''}`}
        disabled={!!setup || interaction === 'drawing' || present}
        onClick={() => toggleMenu('ball')}
        aria-expanded={menuOpen === 'ball'}
        title={ballText}
      >
        🏈 <span className="ball-sentence">{ballText}</span>
        {ballWarning && <span className="warn" title={ballWarning}>!</span>}
      </button>
      {menuOpen === 'ball' && (
        <div className="popover ball-pop">
          {ball ? (
            <>
              {/* NOW: what the play currently does, and anything the engine
                  wants to say about whether it can. */}
              <div className="now-card">
                <b>Now:</b> {ballText}
                {nowDepth ? `, ${nowDepth}` : ''}.
                {ballNote && <div className="now-note">{ballNote}</div>}
              </div>
              <div className="pop-title">Change to</div>
            </>
          ) : (
            <div className="pop-title">What happens with the ball?</div>
          )}
          {BALL_CHOICES.map((c) => {
            // SPEC §12.3: with nobody but the QB on offense there is nobody
            // to give it to. Keeping it is still an answer; the other four
            // would open a pick with no legal choice in it.
            const unavailable = c.kind !== 'keep' && !anyBallEligible
            return (
              <button
                key={c.kind}
                disabled={unavailable}
                title={unavailable ? 'Add an offensive player first.' : undefined}
                onClick={() => startSetup(c.kind)}
              >
                <span className={`now-dot${ball?.kind === c.kind ? ' on' : ''}`} aria-hidden="true">
                  {ball?.kind === c.kind ? '●' : ''}
                </span>
                {ball ? c.short : c.long}
              </button>
            )
          })}
          {ball && ball.kind !== 'keep' && (
            <>
              <div className="pop-title">Then…</div>
              {THEN_KINDS.map((k) => (
                <button key={k} onClick={() => startSetup(k, true)}>
                  {k === 'handoff' ? 'Then hand off to…' : k === 'pitch' ? 'Then pitch to…' : 'Then throw to…'}
                </button>
              ))}
              {ballThen && (
                <button className="pop-clear" onClick={() => { setBallThen(null); setMenuOpen(null); reset() }}>
                  Clear the second action
                </button>
              )}
            </>
          )}
          {canAdvanced && (
            <>
              {/* A disclosure, shut until asked for: the throw point is a
                  detail most plays never touch. Its state is remembered for
                  the page load only - it is a preference about a menu, not
                  anything about the play. */}
              <button
                className={`adv-toggle${advancedOpen ? ' open' : ''}`}
                onClick={() => { advancedOpenMemo = !advancedOpen; setAdvancedOpen(advancedOpenMemo) }}
                aria-expanded={advancedOpen}
              >
                Advanced <span className="key">{advancedOpen ? '▾' : '▸'}</span>
              </button>
              {advancedOpen && (
                <div className="adv-body">
                  <div className="pop-title">
                    Throw point: {hasReleaseOverride ? 'set by you' : 'end of drop'}
                  </div>
                  <button onClick={startPickRelease}>Set on field…</button>
                  {hasReleaseOverride && <button onClick={useDefaultRelease}>Use end of drop</button>}
                </div>
              )}
            </>
          )}
          {ball && (
            <button className="pop-clear" onClick={() => { setBall(null); setBallThen(null); setMenuOpen(null); reset() }}>
              Clear the ball
            </button>
          )}
        </div>
      )}
    </div>
  )

  /**
   * EVERYTHING THAT IS NOT ONE OF THE SEVEN (SPEC §8).
   *
   * Four groups, in this order, with nothing else ever added: how he runs it,
   * what to do with the assignment, where the QB throws from, and the man
   * himself. These all used to be spread across the strip and a chip menu,
   * which is why the strip could not be read at a glance.
   */
  const autoEnd = selected && drawnSchedule.has(selected.id) ? resolveEnd({ ...selected, endBehavior: undefined }, drawnSchedule.get(selected.id)!) : null
  const canEndBehavior = !!selected && selected.side === 'offense' && selected.id !== qbId && !!autoEnd
  const moreMenu = selected ? (
    <div className="popover more-pop">
      <div className="pop-title">How he runs it</div>
      <div className="more-row">
        <label className="lbl">Speed</label>
        <Seg value={selected.speed} options={SPEEDS} onChange={(speed) => updatePlayer(selected.id, { speed })} size="sm" />
      </div>
      {canEndBehavior && (
        <div className="more-row stacked">
          <label className="lbl">After the route</label>
          <div className="more-choices">
            {/*
              The automatic answer is offered as itself, not as the word
              "Auto": a coach wants to know what the man DOES. Choosing the
              option that matches the automatic answer clears the override
              rather than freezing today's guess into the play.
            */}
            {(['continue', 'settle'] as EndBehavior[]).map((v) => {
              const isAuto = autoEnd === v
              const chosen = (selected.endBehavior ?? autoEnd) === v
              const explicit = selected.endBehavior === v
              return (
                <button
                  key={v}
                  className={`more-choice${chosen ? ' on' : ''}`}
                  onClick={() => updatePlayer(selected.id, { endBehavior: isAuto ? undefined : v })}
                >
                  <span className="more-radio" aria-hidden="true">{chosen ? '●' : '○'}</span>
                  {v === 'continue' ? 'Keeps running' : 'Stops'}
                  {isAuto && !explicit ? ' (auto)' : ''}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div className="pop-title">Assignment</div>
      <button disabled={!hasPath} onClick={() => startCopy(false)}>Copy his assignment to…</button>
      <button disabled={!hasPath} onClick={() => startCopy(true)}>Mirror his assignment to…</button>
      <button className="pop-clear" disabled={!hasPath} onClick={() => { setMenuOpen(null); clearPath(selected.id) }}>
        Clear assignment <span className="key">Delete</span>
      </button>

      {selected.id === qbId && canPickRelease && (
        <>
          <div className="pop-title">Throw point</div>
          {/* The same two handlers the ball menu's Advanced uses - one throw
              point, reachable from the man or from the ball. */}
          <button onClick={startPickRelease}>Set on field…</button>
          {hasReleaseOverride && <button onClick={useDefaultRelease}>Use end of drop</button>}
        </>
      )}

      <div className="pop-title">Player</div>
      <button onClick={() => { setMenuOpen(null); setRenaming('player') }}>Rename…</button>
      <button className="pop-clear" onClick={() => removePlayer(selected.id)}>Remove from play</button>
    </div>
  ) : null

  /*
    THE SITUATION LIVES IN THE DOCK (ML-UX-6, SPEC §9 row 9). Down and
    distance describe the field the play is run on, not whoever is selected,
    so it left the strip; and the dock is still there in Present, where a
    coach reads "3rd & 7" aloud - so it is NOT disabled there any more (§3.2
    lets the situation menu open in Present; §13: "always incl. Present").
    It opens upward because the dock is on the bottom edge.
  */
  const situationChip = (
    <div className="ball-menu">
      <button
        className={`sit-chip${menuOpen === 'situation' ? ' active' : ''}`}
        onClick={() => toggleMenu('situation')}
        aria-expanded={menuOpen === 'situation'}
        // The chip is capped at 180 px and the label can outrun it, so the
        // tooltip carries the whole thing.
        title={`${situationLabel(situation)} — down, distance, spot and hash`}
      >
        {situationLabel(situation)}
      </button>
      {menuOpen === 'situation' && (
        <div className="popover sit-pop" onKeyDown={(e) => e.stopPropagation()}>
          <div className="pop-title">Situation</div>
          <div className="sit-row">
            <label className="lbl">Down</label>
            <Seg value={situation.down} options={[1, 2, 3, 4].map((d) => ({ value: d as 1 | 2 | 3 | 4, label: ['1st', '2nd', '3rd', '4th'][d - 1] }))} onChange={(down) => setSituation((s) => ({ ...s, down }))} size="sm" />
          </div>
          <div className="sit-row">
            <label className="lbl">Distance</label>
            <input type="number" min={1} max={99} value={situation.distance} onChange={(e) => setSituation((s) => ({ ...s, distance: Math.max(1, Math.min(99, Number(e.target.value) || 1)) }))} />
            <span className="hint">yards to go</span>
          </div>
          <div className="sit-row">
            <label className="lbl">Ball on</label>
            <input type="number" min={1} max={99} value={situation.losYard} onChange={(e) => setSituation((s) => ({ ...s, losYard: Math.max(1, Math.min(99, Number(e.target.value) || 1)) }))} />
            <span className="hint">{situation.losYard < 50 ? 'own' : situation.losYard > 50 ? 'opponent' : 'midfield'} (1–99 from own goal)</span>
          </div>
          <div className="sit-row">
            <label className="lbl">Hash</label>
            <Seg value={situation.hash} options={HASHES} onChange={setHash} size="sm" />
          </div>
          {/* Markings used to be here. Whether the field shows them is a
              display choice, not part of the situation, so it is in Display
              now - the same `situation.show`, only reached from there. */}
        </div>
      )}
    </div>
  )

  return (
    <div ref={appRef} className={`app${present ? ' present' : ''}${pulseHandle ? '' : ' drew-once'}`}>
      <div className="bar">
        {/* ML-UX-8: in Present the only way out is Exit Present. A stray click
            on "← Library" in a meeting would drop the coach out of teaching
            and into the Library. It comes back the moment he exits. */}
        {!present && exit}
        <div className="brand">
          Peira <span>Motion Lab</span>
        </div>

        {/* The play: name, library, undo */}
        <div className="ball-menu">
          {present ? (
            // Present names the play; it does not offer it (SPEC §2, §13).
            <span className="play-name present-name" title={playName}>{playName}</span>
          ) : renaming === 'play' ? (
            <InlineName value={playName} onCommit={(v) => { setPlayName(v); setRenaming(null) }} onCancel={() => setRenaming(null)} placeholder="Play name" />
          ) : (
            <button className={`play-btn${menuOpen === 'play' ? ' active' : ''}`} onClick={() => (present ? undefined : toggleMenu('play'))} aria-expanded={menuOpen === 'play'} title={present ? playName : 'Play: rename, open, duplicate, delete'}>
              <span className="play-name">{playName}</span>
              {!present && <span className="key">▾</span>}
            </button>
          )}
          {menuOpen === 'play' && !present && (
            <div className="popover play-pop">
              <button onClick={() => { setMenuOpen(null); setRenaming('play') }}>Rename…</button>
              <button onClick={() => createPlay(players)}>New play (this formation)</button>
              <button onClick={duplicatePlay}>Duplicate</button>
              {/* SPEC §13: it used to sit in the strip, permanently, for
                  something a coach does once in a while and never by accident. */}
              <button disabled={!hasPaths} onClick={() => { setMenuOpen(null); clearAllPaths() }}>Clear all assignments</button>
              <button className="pop-clear" onClick={deletePlay}>Delete play</button>
              <div className="pop-title">Open</div>
              <div className="play-list">
                {plays.map((p) => (
                  <button key={p.id} className={`play-row${p.id === playId ? ' active' : ''}`} onClick={() => { if (p.id !== playId) switchTo(p); setMenuOpen(null) }}>
                    <span className="play-row-name">{p.name}</span>
                    <span className="play-row-when">{fmtWhen(p.updatedAt)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {!present &&
          (typeof saveStatus === 'function' ? saveStatus({ editPending: saving }) : saveStatus ?? (
            // Saving outranks a past failure: the next edit IS the retry
            // (SPEC §3.3), so while it is pending the honest word is
            // "Saving…". If it fails again, "Not saved" comes straight back.
            <span className={`saved${!saving && saveFailed ? ' failed' : ''}`} title={saving ? '' : saveFailed ? 'Could not save to browser storage' : savedAt ? `Saved ${fmtWhen(savedAt)}` : ''}>
              {saving ? 'Saving…' : saveFailed ? 'Not saved' : savedAt ? 'Saved' : ''}
            </span>
          ))}
        {!present && (
          <div className="seg">
            <button disabled={!canUndo} onClick={undo} title="Undo · Ctrl+Z">↶</button>
            <button disabled={!canRedo} onClick={redo} title="Redo · Ctrl+Shift+Z">↷</button>
          </div>
        )}

        {/*
          ML-UX-2: the running instruction used to sit here, between the play's
          name and the view controls, which made the top bar two things at once.
          It belongs with the man it is talking about, so it moved to the strip.
        */}
        <div className="spacer" />

        {/* "How I am watching", never an editing mode - hence the label
            (SPEC §2, §11.1). ML-UX-2 added the rule that hides it below
            1300 px but never the label itself. */}
        <label className="lbl view-label">View</label>
        <Seg value={view} options={VIEWS} onChange={switchView} />

        {/* Present and Exit Present are OUTLINED gold: important, not the
            primary. Play is the one solid-gold control on the screen. */}
        {present ? (
          <>
            {/* Telestration is Overhead only (SPEC §16). No banner while he
                draws - Present has no strip, and a row appearing would move
                the field under the pen - so the lit button is the state. */}
            {view === 'overhead' && (
              <div className="seg">
                <button
                  className={telestrating ? 'active' : ''}
                  onClick={() => setTelestrating((t) => !t)}
                  title={telestrating ? 'Draw on the field while paused · Esc to stop' : 'Draw on the field while paused'}
                >
                  ✎ Draw
                </button>
                {/* Enabled even with nothing to clear: nothing visible in
                    Present is disabled (SPEC §3.3). With no marks it does
                    nothing. */}
                <button onClick={() => setStrokes([])}>Clear marks</button>
              </div>
            )}
            <button className="gold-line" onClick={exitPresent}>
              Exit Present
            </button>
          </>
        ) : (
          <>
            <button className="gold-line" onClick={enterPresent} title="Hide the tools and teach">
              Present
            </button>
          </>
        )}
      </div>

      {/*
        THE STRIP. Always rendered while authoring, so the field never jumps
        when a player is selected. Present has NO strip at all (SPEC §2, §3.3,
        ML-UX-8): no controls, no summary, no ball note, no banner - the field
        takes the 44 px, and a highlighted man is a ring on the field. The
        grid drops to three rows with it (motionLab.css, ML-UX-8).
      */}
      {!present && (
      <div className="bar context">
        {interaction === 'draw-armed' || interaction === 'drawing' ? (
          /*
            THE WAITING ROW (SPEC §2). While the coach is part-way through
            something the strip says so and offers the way out, instead of
            showing controls for a man whose route is mid-flight.

            Adjusting is NOT one of these (SPEC §5.3 gives it no banner): the
            strip's Adjust button says so itself, in gold-line, and the strip
            stays on screen where a coach can reach Timing while he works.
            ML-UX-2 borrowed this row for it only because that button did not
            exist yet.
          */
          <>
            <span className="banner">{hint}</span>
            <div className="spacer" />
            <button onClick={clicked(cancelDrawing)} title="Cancel · Esc">
              Cancel<span className="key">Esc</span>
            </button>
          </>
        ) : pickingViewer ? (
          /* CHOOSING A VIEWER (SPEC §3.3, §11.2): a waiting state, so it wears
             the same banner as a drawing or a pick - one sentence and the way
             out. Every player is a legal answer. */
          <>
            <span className="banner">
              <span className="banner-icon">👁</span>
              <b>Click the player to watch from.</b>
            </span>
            <div className="spacer" />
            <button onClick={() => setView('overhead')} title="Cancel · Esc">
              Cancel<span className="key">Esc</span>
            </button>
          </>
        ) : watching && view === 'player' && viewer ? (
          /* WATCHING FROM A MAN: who, how to change him, and what that means. */
          <>
            <div className={`chip ${viewer.side}`}>{viewer.label}</div>
            <div className="ball-menu">
              <button className={menuOpen === 'viewer' ? 'active' : ''} onClick={() => toggleMenu('viewer')} aria-expanded={menuOpen === 'viewer'}>
                Change <span className="key">▾</span>
              </button>
              {menuOpen === 'viewer' && (
                <div className="popover viewer-pop">
                  {(['offense', 'defense'] as const).map((side) => (
                    <div key={side} className="viewer-row">
                      {players
                        .filter((p) => p.side === side)
                        .map((p) => (
                          <button key={p.id} className={`viewer-chip ${p.side}${p.id === viewerId ? ' active' : ''}`} onClick={() => { setViewerId(p.id); setMenuOpen(null) }}>
                            {p.label}
                          </button>
                        ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <span className="hint">Camera rides with the {viewer.label}.</span>
          </>
        ) : watching ? (
          <span className="hint">Watching from the sideline. Switch to Overhead to edit.</span>
        ) : setup ? (
          /* A pick is a waiting state, so it wears the same banner a drawing
             does (SPEC §11.2). This branch stays BELOW the drawing one above:
             the two cannot both be true, and keeping the order explicit is
             what makes that safe to rely on. */
          <>
            <span className="banner">
              <span className="banner-icon">{setup.step === 'copy-to' ? '⧉' : '🏈'}</span>
              {instruction}
            </span>
            <div className="spacer" />
            <button onClick={cancelSetup} title="Cancel · Esc">Cancel<span className="key">Esc</span></button>
          </>
        ) : selected ? (
          /*
            THE SELECTED-PLAYER STRIP (SPEC §4.1). Seven controls in a fixed
            order that never reflows: who, draw, adjust, when, who he blocks,
            everything else, and what he ends up doing. Anything that is not
            one of those seven lives under More - the strip used to carry nine
            groups and a coach had to read it to find the one he wanted.
          */
          <>
            {/* 1. WHO. Not a button any more: renaming and removing are under
                   More, and a chip that opened a menu was the only place they
                   ever lived. It still hosts the inline rename field. */}
            {renaming === 'player' ? (
              <InlineName value={selected.label} onCommit={(v) => { updatePlayer(selected.id, { label: v.slice(0, 4).toUpperCase() }); setRenaming(null) }} onCancel={() => setRenaming(null)} placeholder="Label" />
            ) : (
              <span className={`chip ${selected.side} chip-static`}>
                {selected.label}
                <span className="chip-side">{selected.side === 'offense' ? 'Offense' : 'Defense'}</span>
              </span>
            )}

            {/* 2. DRAW. The same arming ML-UX-1 built; solid gold while there
                   is nothing to run, plain once there is. */}
            <button
              className={`strip-primary${hasPath ? '' : ' primary'}`}
              onClick={clicked(armDrawing)}
              title={hasPath ? 'Draw it again · D' : 'Draw what he does · D'}
            >
              {hasPath ? 'Redraw' : '✎ Draw assignment'}
            </button>

            {/* 3. ADJUST. Only means something once there is a route, and says
                   so itself while it is on - which is why adjusting no longer
                   needs a banner. */}
            {hasPath && (
              <button
                className={interaction === 'adjusting' ? 'gold-line' : ''}
                onClick={clicked(() => {
                  cancelDrawing()
                  setInteraction((i) => (i === 'adjusting' ? 'idle' : 'adjusting'))
                })}
                title="Move the points of his route · E"
              >
                Adjust
              </button>
            )}

            {/* 4. WHEN. Always present, path or no path. */}
            <span className="group">
              <label className="lbl timing-label">Timing</label>
              <Seg value={selected.timing} options={TIMINGS} onChange={(timing) => updatePlayer(selected.id, { timing })} size="sm" />
              {selected.timing === 'delayed' && (
                <span className="delay">
                  <input type="number" min={0} max={5} step={0.1} value={selected.delay} onChange={(e) => updatePlayer(selected.id, { delay: Number(e.target.value) })} />
                  <span>s</span>
                </span>
              )}
            </span>

            {/* 5. WHO HE MEETS. The engaged group here is still today's;
                   ML-UX-5 replaces it with the design's [Blocks DE ▾]. */}
            {engageControls}

            {/* 6. EVERYTHING ELSE. */}
            <div className="ball-menu">
              <button
                className={menuOpen === 'more' ? 'active' : ''}
                onClick={() => toggleMenu('more')}
                aria-expanded={menuOpen === 'more'}
              >
                More <span className="key">▾</span>
              </button>
              {menuOpen === 'more' && moreMenu}
            </div>

            {/* 7. WHAT HE ENDS UP DOING (ML-UX-7, SPEC §4.4): derived from the
                   schedule he actually runs, never stored. It is the one thing
                   in the strip that gives way - it ellipsizes before any
                   control is squeezed - so the whole line is in its tooltip. */}
            <div className="spacer" />
            <span className="strip-summary" title={summary}>{summary}</span>
          </>
        ) : (
          /*
            RESTING (SPEC §3.3): one button and one sentence. Players and Look
            were two menus for one idea - who is on the field and how they are
            arranged - so they are one menu called Formation. The situation
            used to sit here as well; it is the field's, not the formation's,
            and lives in the dock.
          */
          <>
            <div className="ball-menu">
              <button
                className={menuOpen === 'formation' ? 'active' : ''}
                onClick={() => toggleMenu('formation')}
                aria-expanded={menuOpen === 'formation'}
              >
                Formation <span className="key">▾</span>
              </button>
              {menuOpen === 'formation' && (
                <div className="popover play-pop-left formation-pop" onKeyDown={(e) => e.stopPropagation()}>
                  <div className="pop-title">Save this arrangement</div>
                  {renaming === 'look' ? (
                    <InlineName value="" placeholder="e.g. Trips Right vs Over" onCommit={(v) => { if (v) saveLook(v); setRenaming(null) }} onCancel={() => setRenaming(null)} />
                  ) : (
                    <button onClick={() => setRenaming('look')}>Save this formation…</button>
                  )}
                  <div className="pop-title">Saved formations</div>
                  {looks.length === 0 && <span className="hint">None yet.</span>}
                  {looks.map((l) => (
                    <div key={l.id} className="look-row">
                      <span className="play-row-name">{l.name}</span>
                      <button onClick={() => { loadLook(l); setMenuOpen(null) }} title="Replace the men on the field with this formation">Load</button>
                      <button onClick={() => { createPlay(l.players, `${l.name} — new play`); setMenuOpen(null) }} title="Start a new play from this formation">New play</button>
                      <button className="pop-clear" onClick={() => deleteLook(l)} title="Delete this formation">×</button>
                    </div>
                  ))}
                  <div className="pop-title">Players</div>
                  <button onClick={() => addPlayer('offense')}>Add offensive player</button>
                  <button onClick={() => addPlayer('defense')}>Add defensive player</button>
                  <div className="pop-foot">{players.filter((p) => p.side === 'offense').length} offense · {players.filter((p) => p.side === 'defense').length} defense</div>
                </div>
              )}
            </div>
            <span className={`hint${hintFlash ? ' hint-flash' : ''}`}>{ballNote ?? 'Drag a player to move him. Click a player to give him a job.'}</span>
          </>
        )}
      </div>
      )}

      <div className="stage">
        {notice}
        {toast && <div className="toast">{toast}</div>}
        {watching ? (
          <FieldView
            cam={
              view === 'player' && viewer
                ? playerCamera(positionAt(viewer, time), orientNow.get(viewer.id)!.look, engagedNow.some((l) => engaged.find((d) => d.id === l.id)?.a === viewer.id || engaged.find((d) => d.id === l.id)?.b === viewer.id))
                : COACH_CAMERA
            }
            losYard={situation.losYard}
            lineToGain={lineToGain}
            showLabels={showLabels}
            strokes={strokes}
            hideId={view === 'player' ? viewerId : null}
            orient={orientNow}
            links={engagedNow}
            players={players}
            positions={new Map(players.map((p) => [p.id, positionAt(p, time)]))}
            schedule={schedule}
            pathVisible={(p) => pathVisible(p) && !(view === 'player' && p.id === viewerId)}
            selectedId={selectedId}
            ball={ballFrame}
            holdingId={ballFrame.carrierId}
            catchPoint={ballTimeline.catchPoint}
            releasePoint={qbHasPath && !present ? ballTimeline.releasePoint : null}
            releaseIsManual={ballTimeline.releaseIsManual}
            snapped={time >= snapAt}
          />
        ) : (
        <OverheadBoard
          svgRef={svgRef}
          className={`board board-${boardState}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => setHoverCatch(null)}
          players={players}
          ball={ball}
          engagements={engagements}
          losYard={situation.losYard}
          lineToGain={lineToGain}
          schedule={schedule}
          drawnSchedule={drawnSchedule}
          snapAt={snapAt}
          ballTimeline={ballTimeline}
          engaged={engaged}
          orientation={orientation}
          time={time}
          showLabels={showLabels}
          pathVisible={pathVisible}
          selectedId={selectedId}
          present={present}
          strokes={strokes}
          editingPath={interaction === 'adjusting'}
          showRouteHandle={showRouteHandle}
          draft={draft}
          teleDraft={teleDraft}
          hoverCatch={hoverCatch}
          catchTargetId={catchTargetId}
          isPickable={pickable}
          isDimmed={(p) => !!setup && (catchTargetId ? p.id !== catchTargetId && p.id !== qbId : !pickable(p) && p.id !== qbId && setup.step !== 'copy-to')}
        />
        )}
      </div>

      {/*
        THE DOCK. What happens with the ball, then watch the play, then how the
        field is displayed - in that order, left to right (ML-UX-2, ML-UX-3).
        Reset and Restart used to be two buttons a coach had to choose between;
        ⟲ is one.
      */}
      <div className="bar bottom">
        {/* Present's dock is everything but the ball (SPEC §2, §6.1): the
            ball is set while authoring, and its divider goes with it. */}
        {!present && (
          <>
            {ballControl}
            <span className="dock-divider" />
          </>
        )}
        <button className="icon-btn" onClick={clicked(restart)} disabled={!canPlay} title="Restart · R" aria-label="Restart">
          ⟲
        </button>
        {/* Keys live in tooltips, not on buttons (SPEC §11.1, DESIGN §18). */}
        <button className="primary play-toggle" onClick={clicked(togglePlay)} disabled={!canPlay} title={playing ? 'Pause · Space' : 'Play · Space'}>
          {playing ? '❚❚ Pause' : '▶ Play'}
        </button>
        <button className="icon-btn" onClick={clicked(() => step(-0.1))} disabled={!canPlay} title="Back 0.1 s · ←" aria-label="Back 0.1 seconds">
          ◁
        </button>
        <button className="icon-btn" onClick={clicked(() => step(0.1))} disabled={!canPlay} title="Forward 0.1 s · →" aria-label="Forward 0.1 seconds">
          ▷
        </button>
        <div className="scrub">
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.01}
            value={time}
            disabled={!canPlay}
            onChange={(e) => {
              setPlaying(false)
              setTime(Number(e.target.value))
            }}
          />
          {canPlay && (
            <div className="snap-mark" style={{ left: `${(snapAt / duration) * 100}%` }}>
              <span>SNAP</span>
            </div>
          )}
        </div>
        {/* Where the clock is, relative to the snap. The play's length is on
            the scrub already, so it does not need saying twice. */}
        <div className="time">{canPlay ? fmtRel(time) : '—'}</div>
        <div className="ball-menu">
          <button
            className={`rate-pill${menuOpen === 'rate' ? ' active' : ''}`}
            onClick={() => toggleMenu('rate')}
            aria-expanded={menuOpen === 'rate'}
            title="Playback rate"
          >
            {rate}× <span className="key">▾</span>
          </button>
          {menuOpen === 'rate' && (
            <div className="popover rate-pop">
              {RATES.map((r) => (
                <button key={r} className={r === rate ? 'active' : ''} onClick={() => { setRate(r); setMenuOpen(null) }}>
                  {r}×
                </button>
              ))}
            </div>
          )}
        </div>
        {/* The third group: the field the play is run on, and how it is shown. */}
        <span className="dock-divider" />
        {situationChip}
        {/* HOW THE FIELD IS DISPLAYED, in one place. Paths and Field markings
            belong to the play and are saved with it; Labels is this screen,
            this session. */}
        <div className="ball-menu">
          <button
            className={menuOpen === 'display' ? 'active' : ''}
            onClick={() => toggleMenu('display')}
            aria-expanded={menuOpen === 'display'}
            title="What the field shows"
          >
            Display <span className="key">▾</span>
          </button>
          {menuOpen === 'display' && (
            <div className="popover display-pop">
              <div className="sit-row">
                <label className="lbl">Paths</label>
                <Seg value={filter} options={FILTERS} onChange={setFilter} size="sm" />
              </div>
              <div className="sit-row">
                <label className="lbl">Labels</label>
                <button className={`labels-btn${showLabels ? ' active' : ''}`} onClick={() => setShowLabels((v) => !v)} title="Show or hide position labels">
                  {showLabels ? 'Shown' : 'Hidden'}
                </button>
              </div>
              {/* Moved from the Situation popover (ML-UX-6, SPEC §9.6). Same
                  `situation.show`, same setter, same Shown / Hidden words as
                  Labels above it: two rows of one menu must not disagree. */}
              <div className="sit-row">
                <label className="lbl">Field markings</label>
                <button className={`markings-btn${situation.show ? ' active' : ''}`} onClick={() => setSituation((s) => ({ ...s, show: !s.show }))} title="Show or hide the line to gain on the field">
                  {situation.show ? 'Shown' : 'Hidden'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
