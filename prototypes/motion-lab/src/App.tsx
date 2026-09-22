import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FieldMarkings } from './FieldMarkings'
import { VIEWBOX, U, FIELD_WIDTH, clampToField, fromView, toView } from './field'
import { defaultSpeed, initialPlayers, type Player, type Side, type SpeedTier, type Timing } from './formation'
import { cumulativeLength, simplify, type EndBehavior, type Pt } from './geometry'
import { buildSchedule, posAt, resolveEnd } from './timeline'
import { ballTargetOf, deriveBall, isPass, projectOntoPath, summarize, THEN_KINDS, type BallAction } from './ball'
import { FieldView } from './FieldView'
import { COACH_CAMERA, playerCamera } from './perspective'
import { buildOrientation, orientationAt } from './orientation'
import { applyEngagements, type Engagement } from './interactions'
import { hashX, lineToGainY, lookFromPlayers, newId, newPlay, situationLabel, type Look, type PathFilter, type Play, type Situation } from './play'
import { storage } from './storage'

type Mode = 'move' | 'draw' | 'edit'
type View = 'overhead' | 'coach' | 'player'

// Free-draw → anchors. Tolerance is in yards; small enough that the coach's
// shape survives, large enough that hand jitter doesn't become a handle.
const ANCHOR_EPS = 0.45
const MIN_SAMPLE_GAP = 0.15
const PLAYER_R = 0.85 * U
const TAIL = 0.4
/** A catch-point click further than this from the route is ignored. */
const CATCH_PICK_RADIUS = 3
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
  | { step: 'pick-partner'; forId: string }
  | { step: 'pick-engage-point'; forId: string; partnerId: string }
  | { step: 'copy-to'; sourceId: string; mirror: boolean }

/** Steps that ask for a point on somebody's path. */
type PathPick = Extract<Setup, { step: 'pick-catch' | 'pick-release' }>

const TIMINGS: { value: Timing; label: string }[] = [
  { value: 'pre-snap', label: 'Pre-Snap' },
  { value: 'on-snap', label: 'On Snap' },
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

const pointsAttr = (pts: Pt[]) =>
  pts
    .map((q) => {
      const v = toView(q)
      return `${v.x},${v.y}`
    })
    .join(' ')

const fmtWhen = (t: number) => {
  const d = new Date(t)
  const today = new Date().toDateString() === d.toDateString()
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export default function App() {
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
  const loadedRef = useRef(false)

  // ---- authoring UI ----------------------------------------------------
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('move')
  const [draft, setDraft] = useState<Pt[] | null>(null)
  const [setup, setSetup] = useState<Setup | null>(null)
  const [menuOpen, setMenuOpen] = useState<null | 'ball' | 'play' | 'players' | 'look' | 'situation' | 'assignment' | 'player' | 'viewer'>(null)
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
  const dragRef = useRef<DragState | null>(null)
  const draftRef = useRef<Pt[] | null>(null)
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
      setMode('move')
      setMenuOpen(null)
      setRenaming(null)
      setPlaying(false)
      setTime(0)
      setStrokes([])
      storage.setCurrentPlayId(p.id)
    },
    [applyAuthoring],
  )

  useEffect(() => {
    const list = storage.listPlays()
    setLooks(storage.listLooks())
    const current = storage.currentPlayId()
    const first = (current && list.find((p) => p.id === current)) || list[0] || newPlay()
    if (!list.some((p) => p.id === first.id)) storage.savePlay(first)
    setPlays(storage.listPlays())
    skipSaveRef.current = true
    openPlay(first)
    loadedRef.current = true
    if (!storage.available()) showToast('Browser storage is unavailable — plays will not persist.')
  }, [openPlay, showToast])

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
    const ok = storage.savePlay(latestRef.current())
    setSaveFailed(!ok)
    if (ok) {
      setSavedAt(Date.now())
      setPlays(storage.listPlays())
    }
  }, [])
  useEffect(() => {
    if (!loadedRef.current || !playId) return
    // Opening a play is not an edit; it must not bump "last edited".
    if (skipSaveRef.current) {
      skipSaveRef.current = false
      return
    }
    dirtyRef.current = true
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
    storage.savePlay(p)
    setPlays(storage.listPlays())
    switchTo(p)
  }
  const duplicatePlay = () => {
    flushSave()
    const p: Play = { ...latestRef.current(), id: newId('play_'), name: `${playName} (copy)`, createdAt: Date.now(), updatedAt: Date.now() }
    storage.savePlay(p)
    setPlays(storage.listPlays())
    switchTo(p)
    setRenaming('play')
  }
  const deletePlay = () => {
    if (!window.confirm(`Delete "${playName}"? This cannot be undone.`)) return
    // Whatever was pending for this play dies with it.
    dirtyRef.current = false
    storage.deletePlay(playId)
    const rest = storage.listPlays()
    setPlays(rest)
    if (rest[0]) switchTo(rest[0])
    else createPlay(players)
  }

  const saveLook = (name: string) => {
    const l = lookFromPlayers(name, players)
    storage.saveLook(l)
    setLooks(storage.listLooks())
    showToast(`Look "${name}" saved.`)
  }
  const loadLook = (l: Look) => {
    // Replacing the men on the field invalidates anything that named them.
    setPlayers(l.players.map((p) => ({ ...p, path: [] })))
    setBall(null)
    setBallThen(null)
    setEngagements([])
    setSelectedId(null)
    reset()
    showToast(`Look "${l.name}" loaded — assignments and ball cleared.`)
  }
  const deleteLook = (l: Look) => {
    if (!window.confirm(`Delete look "${l.name}"?`)) return
    storage.deleteLook(l.id)
    setLooks(storage.listLooks())
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

  const restart = useCallback(() => {
    if (duration === 0) return
    setTime(0)
    setPlaying(true)
  }, [duration])

  // ---- player edits ---------------------------------------------------

  const updatePlayer = useCallback((id: string | null, patch: Partial<Player>) => {
    if (!id) return
    setPlayers((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }, [])

  const clearPath = useCallback(
    (id: string | null) => {
      updatePlayer(id, { path: [] })
      setMode((m) => (m === 'edit' ? 'move' : m))
    },
    [updatePlayer],
  )

  const clearAllPaths = useCallback(() => {
    setPlayers((ps) => ps.map((p) => ({ ...p, path: [] })))
    setMode((m) => (m === 'edit' ? 'move' : m))
  }, [])

  const qbId = players.find((p) => p.side === 'offense' && p.label === 'QB')?.id

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
    setMode('move')
    reset()
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
      setMode('move')
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
    setMode('move')
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
    if (setup.step === 'pick-partner') return p.id !== setup.forId
    if (setup.step === 'copy-to') return p.id !== setup.sourceId
    if (setup.step === 'pick-catch' || setup.step === 'pick-release' || setup.step === 'pick-engage-point') return false
    if ('then' in setup && setup.then) return p.side === 'offense' && p.id !== (ballTimeline.chain?.carrierId ?? qbId)
    if (p.side !== 'offense' || p.id === qbId) return false
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
      case 'pick-partner':
        setSetup({ step: 'pick-engage-point', forId: setup.forId, partnerId: id })
        break
      case 'copy-to':
        copyAssignment(setup.sourceId, id, setup.mirror)
        setSetup(null)
        break
      case 'pick-target':
        if (schedule.has(id)) setSetup({ step: 'pick-catch', fakeId: setup.fakeId, targetId: id, then: setup.then })
        // A receiver with no route is caught where they stand — nothing to pick.
        else finishPass({ step: 'pick-catch', fakeId: setup.fakeId, targetId: id, then: setup.then }, { x: p.x, y: p.y })
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
        const { forId, partnerId } = setup
        setEngagements((es) => [...es, { id: newId('e'), kind: 'engage', a: forId, b: partnerId, point: clampToField(pos) }])
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
      svgRef.current!.setPointerCapture(e.pointerId)
      return
    }

    // Edit Path handles sit above everything else.
    if (mode === 'edit' && selectedId) {
      const idx = hitAttr(e.target, 'data-anchor')
      if (idx !== null) {
        const p = players.find((pl) => pl.id === selectedId)!
        const a = p.path[Number(idx)]
        dragRef.current = { kind: 'anchor', id: selectedId, index: Number(idx), dx: a.x - pos.x, dy: a.y - pos.y }
        svgRef.current!.setPointerCapture(e.pointerId)
        return
      }
    }

    if (mode === 'draw') {
      let startId = selectedId
      if (hit) {
        startId = hit
        setSelectedId(hit)
      }
      if (!startId) return
      const start = players.find((p) => p.id === startId)!
      // The path is always anchored at the player, wherever the pointer went down.
      draftRef.current = [{ x: start.x, y: start.y }, pos]
      setDraft(draftRef.current)
      svgRef.current!.setPointerCapture(e.pointerId)
      return
    }

    if (hit) {
      const p = players.find((pl) => pl.id === hit)!
      setSelectedId(hit)
      setRenaming(null)
      // Edit mode only means something for a player with a path.
      if (mode === 'edit' && p.path.length < 2) setMode('move')
      dragRef.current = { kind: 'player', id: hit, index: 0, dx: p.x - pos.x, dy: p.y - pos.y }
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
        setEngagements((es) => es.map((x) => (x.id === drag.id ? { ...x, point: next } : x)))
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
      svgRef.current?.releasePointerCapture(e.pointerId)
      return
    }
    const d = draftRef.current
    if (d) {
      draftRef.current = null
      setDraft(null)
      svgRef.current?.releasePointerCapture(e.pointerId)
      // A bare click (no real movement) selects without drawing.
      const cum = cumulativeLength(d)
      if (cum[cum.length - 1] < 1) return
      updatePlayer(selectedId, { path: simplify(d, ANCHOR_EPS) })
    }
  }

  // ---- keyboard -------------------------------------------------------

  const selected = players.find((p) => p.id === selectedId) ?? null
  const hasPath = !!selected && selected.path.length > 1

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return
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
        case 'v':
        case 'V':
          if (!present) setMode('move')
          break
        case 'd':
        case 'D':
          if (selectedId && !setup && !watching && !present) setMode('draw')
          break
        case 'e':
        case 'E':
          if (hasPath && !setup && !watching && !present) setMode((m) => (m === 'edit' ? 'move' : 'edit'))
          break
        case 'b':
        case 'B':
          if (!setup && !watching && !present) setMenuOpen((o) => (o === 'ball' ? null : 'ball'))
          break
        case 'Escape':
          if (menuOpen) setMenuOpen(null)
          else if (renaming) setRenaming(null)
          else if (telestrating) setTelestrating(false)
          else if (pickingViewer) setView('overhead')
          else if (setup) cancelSetup()
          else if (mode !== 'move') setMode('move')
          else setSelectedId(null)
          break
        case ' ':
          e.preventDefault()
          togglePlay()
          break
        case 'r':
        case 'R':
          reset()
          break
        case 'Delete':
        case 'Backspace':
          if (!setup && !present) clearPath(selectedId)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, hasPath, mode, setup, menuOpen, renaming, telestrating, pickingViewer, watching, present, togglePlay, reset, clearPath, cancelSetup, undo, redo])

  // Leaving the selection empties draw/edit mode of meaning.
  useEffect(() => {
    if (!selectedId && mode !== 'move') setMode('move')
  }, [selectedId, mode])

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
    setMode('move')
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
    setMode('move')
    reset()
    setSetup({ step: 'copy-to', sourceId: selected.id, mirror })
  }

  // Time shown relative to the snap: "-1.2s" is pre-snap, "+0.8s" is post.
  const fmtRel = (t: number) => {
    const r = t - snapAt
    return `${r < 0 ? '−' : '+'}${Math.abs(r).toFixed(1)}s`
  }

  const hint = (() => {
    if (present) return telestrating ? <>Draw on the field while paused. <b>Esc</b> to stop drawing.</> : <>Teaching. Click a player to highlight him.</>
    if (pickingViewer) return <>Player view — <b>click the player</b> to watch from.</>
    if (watching) return <>{view === 'coach' ? 'Coach' : 'Player'} view is for watching. Switch to <b>Overhead</b> to edit.</>
    if (setup) return <>{setup.step === 'copy-to' ? 'Copying an assignment' : 'Setting the ball action'} — <b>Esc</b> to cancel.</>
    if (mode === 'draw') return <>Draw <b>{selected?.label}</b>'s path on the field. Drawing again replaces it. <b>Esc</b> to finish.</>
    if (mode === 'edit') return <>Drag a handle to adjust <b>{selected?.label}</b>'s path. Hard breaks stay sharp. <b>Esc</b> to finish.</>
    if (!selected) return <>Drag any player. Click one, then <b>Draw Path</b> (D). Then set the <b>Ball</b>.</>
    if (!hasPath) return <><b>{selected.label}</b> selected — press <b>D</b> and draw their path.</>
    return <><b>{selected.label}</b> — <b>D</b> redraw · <b>E</b> edit path · <b>Delete</b> clear.</>
  })()

  const instruction = (() => {
    if (!setup) return null
    switch (setup.step) {
      case 'pick-carrier': {
        const who = setup.then ? name(ballTimeline.chain?.carrierId ?? qbId ?? '') : 'QB'
        return setup.kind === 'pitch' ? <>{setup.then ? <>Then <b>{who}</b> pitches — </> : <>Pitch — </>}<b>click who gets the pitch</b>.</> : <>{setup.then ? <>Then <b>{who}</b> hands off — </> : <>Handoff — </>}<b>click the ball carrier</b>.</>
      }
      case 'pick-fake':
        return <>Play action — <b>click the back to fake to</b>.</>
      case 'pick-target':
        return <>{setup.fakeId ? <>Faking to <b>{name(setup.fakeId)}</b>. Now </> : setup.then ? <>Then <b>{name(ballTimeline.chain?.carrierId ?? qbId ?? '')}</b> throws — </> : <>Pass — </>}<b>click the receiver</b>.</>
      case 'pick-catch':
        return <>Click on <b>{name(setup.targetId)}</b>'s route where the ball should arrive.</>
      case 'pick-release':
        return <>Click on the <b>QB</b>'s path where he throws from.</>
      case 'pick-partner':
        return <>Engage — <b>click who {name(setup.forId)} engages</b>.</>
      case 'pick-engage-point':
        return <><b>{name(setup.forId)}</b> ↔ <b>{name(setup.partnerId)}</b>: click <b>where they meet</b>.</>
      case 'copy-to':
        return <>{setup.mirror ? 'Mirror' : 'Copy'} <b>{name(setup.sourceId)}</b>'s assignment — <b>click the player</b> who gets it.</>
    }
  })()

  // ENGAGE for the selected player: one button, or who he's engaged with + Remove.
  const selectedEngagement = selected ? engagements.find((x) => x.a === selected.id || x.b === selected.id) ?? null : null
  const selectedDerived = selectedEngagement ? engaged.find((d) => d.id === selectedEngagement.id) ?? null : null
  const engageControls = selected ? (
    selectedEngagement ? (
      <span className="group">
        <label className="lbl">Engage</label>
        <span className="engaged-with">
          ↔ {name(selectedEngagement.a === selected.id ? selectedEngagement.b : selectedEngagement.a)}
          {selectedEngagement.release && <span className="release-note"> · {name(selectedEngagement.release)} releases</span>}
        </span>
        {selectedDerived?.warning && <span className="warn" title={selectedDerived.warning}>!</span>}
        {selectedEngagement.release === selected.id ? (
          <button
            className="active"
            title="Stay on the block for the whole play"
            onClick={() => setEngagements((es) => es.map((x) => (x.id === selectedEngagement.id ? { ...x, release: undefined } : x)))}
          >
            Release ✓
          </button>
        ) : (
          <button
            title={`${selected.label} comes off after a moment and carries on with his path`}
            onClick={() => setEngagements((es) => es.map((x) => (x.id === selectedEngagement.id ? { ...x, release: selected.id } : x)))}
          >
            Release
          </button>
        )}
        <button onClick={() => setEngagements((es) => es.filter((x) => x.id !== selectedEngagement.id))}>Remove</button>
      </span>
    ) : (
      <button
        onClick={() => {
          setMode('move')
          reset()
          setSetup({ step: 'pick-partner', forId: selected.id })
        }}
      >
        Engage…
      </button>
    )
  ) : null
  // Pairs that are engaged at this instant, for the link drawn between them.
  const engagedNow = engaged
    .filter((d) => d.valid && d.time !== null && time >= d.time && (d.until === null || time < d.until))
    .map((d) => ({ id: d.id, a: positionAt(players.find((p) => p.id === d.a)!, time), b: positionAt(players.find((p) => p.id === d.b)!, time), since: time - d.time! }))

  const ballV = toView(ballFrame.pos)
  const ballScale = 1 + 0.8 * ballFrame.lift
  const catchMarker = ballTimeline.catchPoint
  const ballNote = ballTimeline.warning && ball ? (
    <><b>Ball:</b> {ballTimeline.warning}</>
  ) : ballTimeline.qbHold > 0.25 && ball ? (
    <><b>Ball:</b> {ballTimeline.passer} holds {ballTimeline.qbHold.toFixed(1)}s at the top of his drop for {isPass(ballThen) ? name(ballThen.targetId) : isPass(ball) ? name(ball.targetId) : ''}'s timing.</>
  ) : ballTimeline.qbEarly > 0.25 && ball ? (
    <><b>Ball:</b> {ballTimeline.passer} lets it go {ballTimeline.qbEarly.toFixed(1)}s before the top of his drop for {isPass(ballThen) ? name(ballThen.targetId) : isPass(ball) ? name(ball.targetId) : ''}'s timing.</>
  ) : null

  const situationChip = (
    <div className="ball-menu">
      <button className={`sit-chip${menuOpen === 'situation' ? ' active' : ''}`} disabled={present} onClick={() => toggleMenu('situation')} title="Down, distance, spot and hash">
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
          <div className="sit-row">
            <label className="lbl">Markings</label>
            <button className={situation.show ? 'active' : ''} onClick={() => setSituation((s) => ({ ...s, show: !s.show }))}>
              {situation.show ? 'Shown' : 'Hidden'}
            </button>
          </div>
        </div>
      )}
    </div>
  )

  return (
    <div className={`app${present ? ' present' : ''}`}>
      <div className="bar">
        <div className="brand">
          Peira <span>Motion Lab</span>
        </div>

        {/* The play: name, library, undo */}
        <div className="ball-menu">
          {renaming === 'play' ? (
            <InlineName value={playName} onCommit={(v) => { setPlayName(v); setRenaming(null) }} onCancel={() => setRenaming(null)} placeholder="Play name" />
          ) : (
            <button className={`play-btn${menuOpen === 'play' ? ' active' : ''}`} onClick={() => (present ? undefined : toggleMenu('play'))} title={present ? playName : 'Play: rename, open, duplicate, delete'}>
              <span className="play-name">{playName}</span>
              {!present && <span className="key">▾</span>}
            </button>
          )}
          {menuOpen === 'play' && !present && (
            <div className="popover play-pop">
              <button onClick={() => { setMenuOpen(null); setRenaming('play') }}>Rename…</button>
              <button onClick={() => createPlay(players)}>New play (this look)</button>
              <button onClick={duplicatePlay}>Duplicate</button>
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
        {!present && (
          <span className={`saved${saveFailed ? ' failed' : ''}`} title={saveFailed ? 'Could not save to browser storage' : savedAt ? `Saved ${fmtWhen(savedAt)}` : ''}>
            {saveFailed ? 'Not saved' : savedAt ? 'Saved' : ''}
          </span>
        )}
        {!present && (
          <div className="seg">
            <button disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">↶</button>
            <button disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Shift+Z)">↷</button>
          </div>
        )}

        <div className="hint top-hint">{hint}</div>

        <Seg value={view} options={VIEWS} onChange={switchView} />

        {present ? (
          <>
            {view === 'overhead' && (
              <div className="seg">
                <button className={telestrating ? 'active' : ''} onClick={() => setTelestrating((t) => !t)} title="Draw on the field while paused">
                  ✎ Draw
                </button>
                <button disabled={strokes.length === 0} onClick={() => setStrokes([])}>Clear marks</button>
              </div>
            )}
            <button className="primary" onClick={exitPresent}>
              Exit Present
            </button>
          </>
        ) : (
          <>
            <div className="seg">
              <button className={mode === 'move' && !setup && !watching ? 'active' : ''} disabled={!!setup || watching} onClick={() => setMode('move')}>
                Move<span className="key">V</span>
              </button>
              <button className={mode === 'draw' ? 'active' : ''} disabled={!selected || !!setup || watching} onClick={() => setMode('draw')}>
                Draw<span className="key">D</span>
              </button>
            </div>
            <div className="ball-menu">
              <button className={`ball-btn${ball ? ' has-action' : ''}${menuOpen === 'ball' ? ' active' : ''}`} disabled={!!setup || watching} onClick={() => toggleMenu('ball')}>
                🏈 {summarize(ball, players)}
                {ballThen && <span className="then-note"> · then {summarize(ballThen, players).replace('Ball: ', '')}</span>}
                {ballTimeline.warning && ball && <span className="warn" title={ballTimeline.warning}>!</span>}
                <span className="key">B</span>
              </button>
              {menuOpen === 'ball' && (
                <div className="popover">
                  {ball && <div className="pop-title">Change to</div>}
                  <button onClick={() => startSetup('keep')}>QB Keep</button>
                  <button onClick={() => startSetup('handoff')}>Handoff…</button>
                  <button onClick={() => startSetup('pitch')}>Pitch…</button>
                  <button onClick={() => startSetup('pass')}>Pass…</button>
                  <button onClick={() => startSetup('play-action')}>Play Action…</button>
                  {isPass(ball) && qbHasPath && (
                    <>
                      <div className="pop-title">Throw point</div>
                      <button onClick={startPickRelease}>Throw from here…</button>
                      {hasReleaseOverride && <button onClick={useDefaultRelease}>Use default (end of QB path)</button>}
                    </>
                  )}
                  {ball && ball.kind !== 'keep' && (
                    <>
                      <div className="pop-title">{ballThen ? 'Then (change)' : 'Then…'}</div>
                      {THEN_KINDS.map((k) => (
                        <button key={k} onClick={() => startSetup(k, true)}>
                          {k === 'handoff' ? 'Handoff…' : k === 'pitch' ? 'Pitch…' : 'Pass…'}
                        </button>
                      ))}
                      {ballThen && (
                        <button className="pop-clear" onClick={() => { setBallThen(null); setMenuOpen(null); reset() }}>
                          Clear second action
                        </button>
                      )}
                    </>
                  )}
                  {ball && (
                    <button className="pop-clear" onClick={() => { setBall(null); setBallThen(null); setMenuOpen(null); reset() }}>
                      Clear ball action
                    </button>
                  )}
                </div>
              )}
            </div>
            <button className="primary" onClick={enterPresent} title="Hide the authoring tools and teach">
              Present
            </button>
          </>
        )}
      </div>

      {/* Always rendered so the field never jumps when a player is selected. */}
      <div className="bar context">
        {present ? (
          <>
            {situationChip}
            {selected && <div className={`chip ${selected.side}`}>{selected.label}</div>}
            <span className="hint">{ballNote ?? (ball ? summarize(ball, players).replace('Ball: ', '') + (ballThen ? ` · then ${summarize(ballThen, players).replace('Ball: ', '')}` : '') : '')}</span>
          </>
        ) : pickingViewer ? (
          <>
            <div className="chip ball">👁</div>
            <span className="instruction">Player view — <b>click the player</b> you want to watch from.</span>
            <div className="spacer" />
            <button onClick={() => setView('overhead')}>Cancel<span className="key">Esc</span></button>
          </>
        ) : watching && view === 'player' && viewer ? (
          <>
            <label className="lbl">Viewing</label>
            <div className={`chip ${viewer.side}`}>{viewer.label}</div>
            <div className="ball-menu">
              <button className={menuOpen === 'viewer' ? 'active' : ''} onClick={() => toggleMenu('viewer')}>Change</button>
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
            <span className="hint">Camera rides with {viewer.label}. Play, scrub, or switch views any time.</span>
          </>
        ) : watching ? (
          <span className="hint">Elevated coaching view. Play, scrub and change views freely; switch to <b>Overhead</b> to edit the play.</span>
        ) : setup ? (
          <>
            <div className="chip ball">{setup.step === 'copy-to' ? '⧉' : '🏈'}</div>
            <span className="instruction">{instruction}</span>
            <div className="spacer" />
            <button onClick={cancelSetup}>Cancel<span className="key">Esc</span></button>
          </>
        ) : selected ? (
          <>
            {/* The man: click his chip to rename or remove him */}
            <div className="ball-menu">
              {renaming === 'player' ? (
                <InlineName value={selected.label} onCommit={(v) => { updatePlayer(selected.id, { label: v.slice(0, 4).toUpperCase() }); setRenaming(null) }} onCancel={() => setRenaming(null)} placeholder="Label" />
              ) : (
                <button className={`chip ${selected.side} chip-btn${menuOpen === 'player' ? ' active' : ''}`} onClick={() => toggleMenu('player')} title="Rename or remove this player">
                  {selected.label} <span className="key">▾</span>
                </button>
              )}
              {menuOpen === 'player' && (
                <div className="popover play-pop-left">
                  <button onClick={() => { setMenuOpen(null); setRenaming('player') }}>Rename…</button>
                  <button className="pop-clear" onClick={() => removePlayer(selected.id)}>Remove from play</button>
                </div>
              )}
            </div>
            {hasPath ? (
              <>
                <span className="group">
                  <label className="lbl">Timing</label>
                  <Seg value={selected.timing} options={TIMINGS} onChange={(timing) => updatePlayer(selected.id, { timing })} size="sm" />
                  {selected.timing === 'delayed' && (
                    <span className="delay">
                      <input type="number" min={0} max={5} step={0.1} value={selected.delay} onChange={(e) => updatePlayer(selected.id, { delay: Number(e.target.value) })} />
                      <span>s</span>
                    </span>
                  )}
                </span>
                <span className="group">
                  <label className="lbl">Speed</label>
                  <Seg value={selected.speed} options={SPEEDS} onChange={(speed) => updatePlayer(selected.id, { speed })} size="sm" />
                </span>
                {selected.side === 'offense' && selected.id !== qbId && drawnSchedule.has(selected.id) && (
                  <span className="group">
                    <label className="lbl">End</label>
                    <Seg
                      value={selected.endBehavior ?? 'auto'}
                      options={[
                        { value: 'auto', label: `Auto (${resolveEnd({ ...selected, endBehavior: undefined }, drawnSchedule.get(selected.id)!) === 'continue' ? 'continue' : 'settle'})` },
                        { value: 'continue', label: 'Continue' },
                        { value: 'settle', label: 'Settle' },
                      ]}
                      onChange={(v: 'auto' | EndBehavior) => updatePlayer(selected.id, { endBehavior: v === 'auto' ? undefined : v })}
                      size="sm"
                    />
                  </span>
                )}
              </>
            ) : (
              <span className="hint">No assignment yet — press <b>D</b> and draw one.</span>
            )}
            <span className="divider" />
            <div className="ball-menu">
              <button className={menuOpen === 'assignment' ? 'active' : ''} onClick={() => toggleMenu('assignment')}>
                Assignment <span className="key">▾</span>
              </button>
              {menuOpen === 'assignment' && (
                <div className="popover play-pop-left">
                  <button onClick={() => { setMenuOpen(null); setMode('draw') }}>Draw path <span className="key">D</span></button>
                  <button disabled={!hasPath} onClick={() => { setMenuOpen(null); setMode('edit') }}>Edit path <span className="key">E</span></button>
                  <button disabled={!hasPath} onClick={() => startCopy(false)}>Copy to…</button>
                  <button disabled={!hasPath} onClick={() => startCopy(true)}>Mirror to…</button>
                  <button className="pop-clear" disabled={!hasPath} onClick={() => { setMenuOpen(null); clearPath(selected.id) }}>Clear assignment <span className="key">⌫</span></button>
                </div>
              )}
            </div>
            {selected.id === qbId && canPickRelease && (
              <>
                <button onClick={startPickRelease}>Throw From Here</button>
                {hasReleaseOverride && <button onClick={useDefaultRelease}>Use Default</button>}
              </>
            )}
            <span className="divider" />
            {engageControls}
          </>
        ) : (
          <>
            {/* Resting: set the look, the men, the situation */}
            <div className="ball-menu">
              <button className={menuOpen === 'players' ? 'active' : ''} onClick={() => toggleMenu('players')}>
                Players <span className="key">▾</span>
              </button>
              {menuOpen === 'players' && (
                <div className="popover play-pop-left">
                  <button onClick={() => addPlayer('offense')}>Add offensive player</button>
                  <button onClick={() => addPlayer('defense')}>Add defensive player</button>
                  <div className="pop-title">{players.filter((p) => p.side === 'offense').length} offense · {players.filter((p) => p.side === 'defense').length} defense</div>
                </div>
              )}
            </div>
            <div className="ball-menu">
              <button className={menuOpen === 'look' ? 'active' : ''} onClick={() => toggleMenu('look')}>
                Look <span className="key">▾</span>
              </button>
              {menuOpen === 'look' && (
                <div className="popover play-pop-left look-pop" onKeyDown={(e) => e.stopPropagation()}>
                  <div className="pop-title">Save this alignment as a look</div>
                  {renaming === 'look' ? (
                    <InlineName value="" placeholder="e.g. Trips Right vs Over" onCommit={(v) => { if (v) saveLook(v); setRenaming(null) }} onCancel={() => setRenaming(null)} />
                  ) : (
                    <button onClick={() => setRenaming('look')}>Save look…</button>
                  )}
                  <div className="pop-title">Saved looks</div>
                  {looks.length === 0 && <span className="hint">None yet.</span>}
                  {looks.map((l) => (
                    <div key={l.id} className="look-row">
                      <span className="play-row-name">{l.name}</span>
                      <button onClick={() => { loadLook(l); setMenuOpen(null) }} title="Replace the men on the field with this look">Load</button>
                      <button onClick={() => { createPlay(l.players, `${l.name} — new play`); setMenuOpen(null) }} title="Start a new play from this look">New play</button>
                      <button className="pop-clear" onClick={() => deleteLook(l)} title="Delete this look">×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {situationChip}
            <span className="hint">{ballNote ?? 'Drag men into the look. Click one to draw his assignment.'}</span>
          </>
        )}
        {!setup && !present && (
          <>
            <div className="spacer" />
            <button disabled={!hasPaths} onClick={clearAllPaths}>
              Clear All Paths
            </button>
          </>
        )}
      </div>

      <div className="stage">
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
        <svg
          ref={svgRef}
          className={`board mode-${mode}${setup ? ' setup' : ''}${present ? ' present' : ''}${telestrating ? ' tele' : ''}`}
          viewBox={VIEWBOX}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => setHoverCatch(null)}
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>

          <FieldMarkings losYard={situation.losYard} lineToGain={lineToGain} />

          {/* Paths: unselected first, selected / catch-target on top */}
          {players
            .filter((p) => schedule.has(p.id) && schedule.get(p.id)!.drawnLength < schedule.get(p.id)!.length && pathVisible(p))
            .map((p) => (
              <polyline
                key={`ext-${p.id}`}
                points={pointsAttr(schedule.get(p.id)!.pts.slice(-2))}
                fill="none"
                stroke={p.id === selectedId ? 'var(--accent)' : p.side === 'offense' ? 'rgba(242,242,238,0.75)' : 'rgba(226,87,58,0.85)'}
                strokeWidth={2.5}
                strokeDasharray="4 6"
                opacity={0.6}
              />
            ))}
          {players
            .filter((p) => p.id !== selectedId && p.id !== catchTargetId && schedule.has(p.id) && pathVisible(p))
            .map((p) => (
              <polyline
                key={`path-${p.id}`}
                points={pointsAttr(drawnSchedule.get(p.id)!.pts)}
                fill="none"
                stroke={p.side === 'offense' ? 'rgba(242,242,238,0.75)' : 'rgba(226,87,58,0.85)'}
                strokeWidth={3}
                strokeDasharray={p.timing === 'pre-snap' ? '2 7' : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
                markerEnd="url(#arrow)"
                opacity={catchTargetId ? 0.25 : 1}
              />
            ))}
          {(catchTargetId ?? selectedId) && schedule.has(catchTargetId ?? selectedId!) && (
            <polyline
              points={pointsAttr(drawnSchedule.get(catchTargetId ?? selectedId!)!.pts)}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={4.5}
              strokeDasharray={players.find((p) => p.id === (catchTargetId ?? selectedId))?.timing === 'pre-snap' ? '2 8' : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
              markerEnd="url(#arrow)"
            />
          )}
          {draft && (
            <polyline points={pointsAttr(draft)} fill="none" stroke="var(--accent)" strokeWidth={4} strokeDasharray="8 6" strokeLinecap="round" strokeLinejoin="round" opacity={0.9} />
          )}

          {/* Where the coach asked for the catch, when the ball ends up elsewhere */}
          {!present && ballTimeline.catchAdjusted && ballTimeline.requestedCatch && catchMarker && !catchTargetId && (() => {
            const a = toView(ballTimeline.requestedCatch)
            const b = toView(catchMarker)
            return (
              <g pointerEvents="none" opacity={0.7}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="3 4" />
                <circle cx={a.x} cy={a.y} r={7} fill="none" stroke="var(--accent)" strokeWidth={1.5} strokeDasharray="3 3" />
              </g>
            )
          })()}
          {/* Catch point: where the ball arrives */}
          {catchMarker && !catchTargetId && (() => {
            const v = toView(catchMarker)
            return (
              <g key={`catch-${adjustedKey}`} className={`catch-marker${ballTimeline.catchAdjusted ? ' adjusted' : ''}`} transform={`translate(${v.x} ${v.y})`} pointerEvents="none">
                <circle className="pulse" r={9} fill="none" stroke="var(--accent)" strokeWidth={2.5} opacity={0.9} />
                <circle r={3} fill="var(--accent)" />
              </g>
            )
          })()}
          {/* Throw point: a small diamond on the QB's path */}
          {!present && ballTimeline.releasePoint && qbHasPath && !catchTargetId && (() => {
            const v = toView(ballTimeline.releasePoint)
            return (
              <g className="throw-point" transform={`translate(${v.x} ${v.y}) rotate(45)`}>
                <title>{hasReleaseOverride ? 'Throw point (set by you)' : ballTimeline.qbEarly > 0.05 ? 'Throw point (derived: early, on the drop)' : ballTimeline.qbHold > 0.05 ? 'Throw point (derived: holds at the top of the drop)' : 'Throw point (derived: top of the drop)'}</title>
                <rect x={-6} y={-6} width={12} height={12} fill={hasReleaseOverride ? '#4da3ff' : 'var(--bg)'} stroke={hasReleaseOverride ? '#0f1012' : '#4da3ff'} strokeWidth={2} />
              </g>
            )
          })()}
          {hoverCatch && (() => {
            const v = toView(hoverCatch)
            return (
              <g transform={`translate(${v.x} ${v.y})`} pointerEvents="none">
                <circle r={11} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeDasharray="4 3" />
                <circle r={3} fill="var(--accent)" />
              </g>
            )
          })()}

          {/* Players */}
          {players.map((p) => {
            const pos = toView(positionAt(p, time))
            const isSel = p.id === selectedId
            const isOff = p.side === 'offense'
            const canPick = pickable(p)
            const dim = !!setup && (catchTargetId ? p.id !== catchTargetId && p.id !== qbId : !canPick && p.id !== qbId && setup.step !== 'copy-to')
            const holding = ballFrame.carrierId === p.id && time >= snapAt
            return (
              <g key={p.id} data-player={p.id} className={`player${canPick ? ' pickable' : ''}`} transform={`translate(${pos.x} ${pos.y})`} opacity={dim ? 0.45 : 1}>
                {isSel && <circle r={PLAYER_R + 6} fill="none" stroke="var(--accent)" strokeWidth={3} opacity={0.9} />}
                {canPick && <circle r={PLAYER_R + 6} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeDasharray="5 4" opacity={0.9} />}
                <circle r={PLAYER_R} fill={isOff ? 'var(--offense)' : 'var(--defense)'} stroke={holding ? 'var(--accent)' : isOff ? '#6b6b66' : '#7a2412'} strokeWidth={holding ? 3 : 2} />
                {showLabels && (
                  <text textAnchor="middle" dominantBaseline="central" fontSize={p.label.length > 2 ? 11 : 13} fontWeight={800} fontFamily="Inter, system-ui, sans-serif" fill={isOff ? '#111' : '#fff'}>
                    {p.label}
                  </text>
                )}
              </g>
            )
          })}

          {/* Football — drawn above the players so it never hides under a marker */}
          <g data-ball data-phase={ballFrame.phase} transform={`translate(${ballV.x} ${ballV.y})`} pointerEvents="none">
            {ballFrame.lift > 0 && <ellipse cy={6 * ballScale} rx={0.5 * U * ballScale} ry={0.28 * U * ballScale} fill="rgba(0,0,0,0.35)" />}
            <g transform={`scale(${ballScale})`}>
              <ellipse rx={0.5 * U} ry={0.3 * U} fill="#8a4b1d" stroke="#2c1608" strokeWidth={1.5} />
              <line x1={-0.22 * U} x2={0.22 * U} y1={0} y2={0} stroke="#fff" strokeWidth={1.5} />
              <line x1={-0.1 * U} x2={-0.1 * U} y1={-2} y2={2} stroke="#fff" strokeWidth={1} />
              <line x1={0.1 * U} x2={0.1 * U} y1={-2} y2={2} stroke="#fff" strokeWidth={1} />
            </g>
          </g>

          {/* Engagements: the coach's point (draggable), and the link once they meet */}
          {engagedNow.map((l) => {
            const a = toView(l.a)
            const b = toView(l.b)
            return (
              <g key={`link-${l.id}`} pointerEvents="none">
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#ff8c42" strokeWidth={6} strokeLinecap="round" opacity={0.9} />
                {l.since < 0.5 && <circle cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} r={10 + l.since * 40} fill="none" stroke="#ff8c42" strokeWidth={3} opacity={1 - l.since * 2} />}
              </g>
            )
          })}
          {!present &&
            engagements.map((en) => {
              const d = engaged.find((x) => x.id === en.id)
              const v = toView(en.point)
              const bad = !d?.valid
              const mine = selected && (en.a === selected.id || en.b === selected.id)
              return (
                <g key={en.id} data-engage={en.id} className="engage-marker" transform={`translate(${v.x} ${v.y})`} opacity={mine || !selected ? 1 : 0.55}>
                  <circle r={14} fill="transparent" />
                  <circle r={8} fill="var(--bg)" stroke={bad ? '#e2573a' : '#ff8c42'} strokeWidth={2.5} />
                  {bad ? (
                    <text textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={900} fill="#e2573a" fontFamily="Inter, system-ui, sans-serif">!</text>
                  ) : (
                    <>
                      <line x1={-3.5} y1={-3.5} x2={3.5} y2={3.5} stroke="#ff8c42" strokeWidth={2} />
                      <line x1={-3.5} y1={3.5} x2={3.5} y2={-3.5} stroke="#ff8c42" strokeWidth={2} />
                    </>
                  )}
                </g>
              )
            })}

          {/* Body (thick stub) and look (thin line + dot) for the selected player only */}
          {!present && selected && (() => {
            const o = orientNow.get(selected.id)!
            const pos = positionAt(selected, time)
            const g = toView(pos)
            const b = toView({ x: pos.x + o.body.x * 1.6, y: pos.y + o.body.y * 1.6 })
            const l = toView({ x: pos.x + o.look.x * 3.2, y: pos.y + o.look.y * 3.2 })
            return (
              <g pointerEvents="none">
                <line x1={g.x} y1={g.y} x2={b.x} y2={b.y} stroke={selected.side === 'offense' ? '#f2f2ee' : '#e2573a'} strokeWidth={5} strokeLinecap="round" opacity={0.9} />
                <line x1={g.x} y1={g.y} x2={l.x} y2={l.y} stroke="var(--accent)" strokeWidth={2} strokeDasharray="4 3" />
                <circle cx={l.x} cy={l.y} r={3.5} fill="var(--accent)" />
              </g>
            )
          })()}

          {/* Edit Path handles: the anchors, minus the start (that's the player) */}
          {!present &&
            mode === 'edit' &&
            selected &&
            selected.path.slice(1).map((a, i) => {
              const v = toView(a)
              return (
                <g key={`anchor-${i + 1}`} data-anchor={i + 1} className="anchor" transform={`translate(${v.x} ${v.y})`}>
                  <circle r={14} fill="transparent" />
                  <circle r={7} fill="var(--bg)" stroke="var(--accent)" strokeWidth={3} />
                </g>
              )
            })}

          {/* Teaching marks */}
          {[...strokes, ...(teleDraft ? [teleDraft] : [])].map((s, i) => (
            <polyline key={`tele-${i}`} points={pointsAttr(s)} fill="none" stroke="#fff27a" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" opacity={0.95} pointerEvents="none" />
          ))}
        </svg>
        )}
      </div>

      <div className="bar bottom">
        <button onClick={reset} disabled={time === 0 && !playing}>
          Reset<span className="key">R</span>
        </button>
        <button className="primary" onClick={togglePlay} disabled={!canPlay}>
          {playing ? '❚❚ Pause' : '▶ Play'}<span className="key">Space</span>
        </button>
        <button onClick={restart} disabled={!canPlay}>
          Restart
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
        <div className="time">{canPlay ? `${fmtRel(time)} / ${fmtRel(duration)}` : '—'}</div>
        <span className="group">
          <label className="lbl">Speed</label>
          <Seg value={rate} options={RATES.map((r) => ({ value: r, label: `${r}×` }))} onChange={setRate} size="sm" />
        </span>
        <span className="group">
          <label className="lbl">Paths</label>
          <Seg value={filter} options={FILTERS} onChange={setFilter} size="sm" />
        </span>
        <button className={`labels-btn${showLabels ? ' active' : ''}`} onClick={() => setShowLabels((s) => !s)} title="Show or hide position labels">
          Labels
        </button>
      </div>
    </div>
  )
}
