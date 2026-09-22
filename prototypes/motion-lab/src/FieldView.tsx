// The perspective renderer, used for both COACH and PLAYER views. Watch-only.
//
// Reads exactly what the overhead renderer reads - players, the movement
// schedule, the ball frame, the markers - and only changes how yards become
// pixels, through whatever camera it is handed. No pointer handling:
// authoring stays in Overhead.

import { FIELD_WIDTH, HASH_LEFT, HASH_RIGHT, MARGIN_X, Y_MAX, Y_MIN, yardLabel } from './field'
import type { Player, Side } from './formation'
import type { Pt } from './geometry'
import type { BallFrame } from './ball'
import type { ScheduleMap } from './timeline'
import type { Orientation } from './orientation'
import { NEAR, VIEW_H, VIEW_W, horizonY, pointsAttr, project, projectPolyline, type Camera } from './perspective'

/** The turf extends past the coaching window so a low camera never sees its edge. */
const TURF_FAR = Y_MIN - 40
const TURF_NEAR = Y_MAX + 40
/** Lines stop a little past the coaching window instead of racing to the horizon. */
const LINES_FAR = Y_MIN - 6
/** Paths end a few yards short of the lens rather than vanishing under it. */
const PATH_NEAR = 3.5
/** A marker never grows past this on screen, however close he stands. */
const MARKER_MAX_PX = 52
/** Ground glyph lengths, yards: a short thick stub for the body, a longer thin one for the eyes. */
const BODY_STUB = 1.0
const LOOK_STUB = 1.9
/** How high a pass is drawn at the top of its arc, yards. */
const FLIGHT_HEIGHT = 3.5
/** Marker "height" (the circle floats this far above its ground point). */
const MARKER_Z = 0.9
/** The ball never shrinks below this on screen; it must always be findable. */
const BALL_MIN_PX = 7

interface Props {
  cam: Camera
  /** Yards from the offense's own goal at the LOS (field numbering). */
  losYard: number
  /** Field y of the line to gain, or null. */
  lineToGain: number | null
  /** Draw position labels on markers. */
  showLabels?: boolean
  /** Teaching marks drawn by the coach, in field yards. */
  strokes?: Pt[][]
  players: Player[]
  positions: Map<string, Pt>
  schedule: ScheduleMap
  pathVisible: (p: Player) => boolean
  selectedId: string | null
  /** The player whose eyes we're using; he is not drawn. */
  hideId?: string | null
  /** Body and look directions per player. */
  orient: Map<string, Orientation>
  /** Pairs engaged at this instant. */
  links: { id: string; a: Pt; b: Pt; since: number }[]
  ball: BallFrame
  holdingId: string | null
  catchPoint: Pt | null
  releasePoint: Pt | null
  /** Filled marker when the coach set the throw point; hollow when derived. */
  releaseIsManual?: boolean
  snapped: boolean
}

function Turf({ cam, losYard, lineToGain }: { cam: Camera; losYard: number; lineToGain: number | null }) {
  const pt = (x: number, y: number, z = 0) => project({ x, y }, cam, z)
  const yardLines: number[] = []
  const ticks: number[] = []
  for (let y = Y_MIN; y <= Y_MAX + 3; y++) {
    const abs = losYard + y
    if (abs < 0 || abs > 100) continue
    if (abs % 5 === 0) yardLines.push(y)
    else ticks.push(y)
  }
  const poly = (pts: Pt[]) => pointsAttr(projectPolyline(pts, cam, true))
  const line = (a: Pt, b: Pt) => projectPolyline([a, b], cam)
  const hz = horizonY(cam)

  return (
    <g>
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0b0d10" />
          <stop offset="1" stopColor="#1c232c" />
        </linearGradient>
      </defs>
      <rect x={0} y={0} width={VIEW_W} height={VIEW_H} fill="url(#sky)" />
      {/* Ground below the horizon, then the out-of-bounds apron, then the turf */}
      <rect x={0} y={Math.max(0, hz)} width={VIEW_W} height={Math.max(0, VIEW_H - hz)} fill="#0e1712" />
      <polygon points={poly([{ x: -MARGIN_X - 30, y: TURF_FAR }, { x: FIELD_WIDTH + MARGIN_X + 30, y: TURF_FAR }, { x: FIELD_WIDTH + MARGIN_X + 30, y: TURF_NEAR }, { x: -MARGIN_X - 30, y: TURF_NEAR }])} fill="#121f18" />
      <polygon points={poly([{ x: 0, y: LINES_FAR }, { x: FIELD_WIDTH, y: LINES_FAR }, { x: FIELD_WIDTH, y: TURF_NEAR }, { x: 0, y: TURF_NEAR }])} fill="#1f4230" />
      <polygon points={poly([{ x: 0, y: TURF_FAR }, { x: FIELD_WIDTH, y: TURF_FAR }, { x: FIELD_WIDTH, y: LINES_FAR }, { x: 0, y: LINES_FAR }])} fill="#183426" />
      {/* 5-yard bands */}
      {yardLines.map((y) =>
        Math.floor((losYard + y) / 5) % 2 === 0 ? (
          <polygon key={`band${y}`} points={poly([{ x: 0, y }, { x: FIELD_WIDTH, y }, { x: FIELD_WIDTH, y: y + 5 }, { x: 0, y: y + 5 }])} fill="rgba(255,255,255,0.035)" />
        ) : null,
      )}
      {yardLines.map((y) => {
        const seg = line({ x: 0, y }, { x: FIELD_WIDTH, y })
        if (seg.length < 2) return null
        return <polyline key={`yl${y}`} points={pointsAttr(seg)} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth={Math.max(1, Math.min(4, seg[0].scale * 0.1))} />
      })}
      {ticks.map((y) => {
        const w = 0.6
        const segs: [number, number][] = [
          [0, w],
          [FIELD_WIDTH - w, FIELD_WIDTH],
          [HASH_LEFT - w / 2, HASH_LEFT + w / 2],
          [HASH_RIGHT - w / 2, HASH_RIGHT + w / 2],
        ]
        return (
          <g key={`tk${y}`} stroke="rgba(255,255,255,0.4)" strokeWidth={1.2}>
            {segs.map(([x1, x2], i) => {
              const seg = line({ x: x1, y }, { x: x2, y })
              return seg.length < 2 ? null : <polyline key={i} points={pointsAttr(seg)} fill="none" />
            })}
          </g>
        )
      })}
      {yardLines.map((y) => {
        const label = yardLabel(y, losYard)
        if (!label) return null
        return [7, FIELD_WIDTH - 7].map((x) => {
          const v = pt(x, y)
          if (v.depth <= NEAR) return null
          return (
            <text key={`num${y}-${x}`} x={v.sx} y={v.sy} fill="rgba(255,255,255,0.28)" fontWeight={700} fontFamily="Inter, system-ui, sans-serif" textAnchor="middle" fontSize={Math.min(80, v.scale * 1.6)}>
              {label}
            </text>
          )
        })
      })}
      {/* Sidelines */}
      {[0, FIELD_WIDTH].map((x) => {
        const seg = line({ x, y: LINES_FAR }, { x, y: TURF_NEAR })
        return seg.length < 2 ? null : <polyline key={`sl${x}`} points={pointsAttr(seg)} fill="none" stroke="#fff" strokeWidth={3} />
      })}
      {/* Line to gain */}
      {lineToGain !== null && lineToGain > 0 && (() => {
        const seg = line({ x: 0, y: lineToGain }, { x: FIELD_WIDTH, y: lineToGain })
        return seg.length < 2 ? null : <polyline points={pointsAttr(seg)} fill="none" stroke="#f7c948" strokeWidth={2} opacity={0.7} />
      })()}
      {/* Line of scrimmage: solid and bright, it is the reference for everything */}
      {(() => {
        const seg = line({ x: 0, y: 0 }, { x: FIELD_WIDTH, y: 0 })
        return seg.length < 2 ? null : <polyline points={pointsAttr(seg)} fill="none" stroke="#4da3ff" strokeWidth={Math.max(2, Math.min(5, seg[0].scale * 0.15))} opacity={0.95} />
      })()}
    </g>
  )
}

export function FieldView({ cam, losYard, lineToGain, showLabels = true, strokes = [], players, positions, schedule, pathVisible, selectedId, hideId, orient, links, ball, holdingId, catchPoint, releasePoint, releaseIsManual = false, snapped }: Props) {
  const pt = (x: number, y: number, z = 0) => project({ x, y }, cam, z)
  const sideStroke = (side: Side) => (side === 'offense' ? 'rgba(242,242,238,0.8)' : 'rgba(226,87,58,0.9)')

  // Everything standing on the field, farthest first so near things overlap far things.
  type Entity = { depth: number; node: React.ReactNode }
  const entities: Entity[] = []

  for (const p of players) {
    if (p.id === hideId) continue
    const pos = positions.get(p.id)!
    const ground = pt(pos.x, pos.y)
    if (ground.depth <= NEAR) continue
    const body = pt(pos.x, pos.y, MARKER_Z)
    const r = Math.min(MARKER_MAX_PX, Math.max(5, body.scale * 0.8))
    const isOff = p.side === 'offense'
    const isSel = p.id === selectedId
    const holding = holdingId === p.id && snapped
    const fontSize = r * (p.label.length > 2 ? 0.75 : 0.9)
    // Body and look, drawn on the turf under the marker: a short thick stub
    // for which way he is turned, a longer thin one with a dot for his eyes.
    const o = orient.get(p.id)
    const bodyEnd = o ? pt(pos.x + o.body.x * BODY_STUB, pos.y + o.body.y * BODY_STUB) : null
    const lookEnd = o ? pt(pos.x + o.look.x * LOOK_STUB, pos.y + o.look.y * LOOK_STUB) : null
    entities.push({
      depth: ground.depth,
      node: (
        <g key={p.id}>
          <ellipse cx={ground.sx} cy={ground.sy} rx={r * 1.1} ry={r * 0.32} fill="rgba(0,0,0,0.4)" />
          {bodyEnd && bodyEnd.depth > NEAR && (
            <line x1={ground.sx} y1={ground.sy} x2={bodyEnd.sx} y2={bodyEnd.sy} stroke={isOff ? 'rgba(242,242,238,0.9)' : 'rgba(226,87,58,0.95)'} strokeWidth={Math.max(2, r * 0.28)} strokeLinecap="round" />
          )}
          {lookEnd && lookEnd.depth > NEAR && (
            <g>
              <line x1={ground.sx} y1={ground.sy} x2={lookEnd.sx} y2={lookEnd.sy} stroke="var(--accent)" strokeWidth={Math.max(1, r * 0.09)} opacity={0.9} />
              <circle cx={lookEnd.sx} cy={lookEnd.sy} r={Math.max(1.5, r * 0.11)} fill="var(--accent)" />
            </g>
          )}
          <line x1={ground.sx} y1={ground.sy} x2={body.sx} y2={body.sy} stroke="rgba(0,0,0,0.35)" strokeWidth={Math.max(1, r * 0.12)} />
          <g transform={`translate(${body.sx} ${body.sy})`}>
            {isSel && <circle r={r + 5} fill="none" stroke="var(--accent)" strokeWidth={2.5} />}
            <circle r={r} fill={isOff ? 'var(--offense)' : 'var(--defense)'} stroke={holding ? 'var(--accent)' : isOff ? '#6b6b66' : '#7a2412'} strokeWidth={holding ? 3 : 2} />
            {showLabels && fontSize >= 7 && (
              <text textAnchor="middle" dominantBaseline="central" fontSize={fontSize} fontWeight={800} fontFamily="Inter, system-ui, sans-serif" fill={isOff ? '#111' : '#fff'}>
                {p.label}
              </text>
            )}
          </g>
        </g>
      ),
    })
  }

  // The ball: the same frame the overhead draws, lifted during a pass, and
  // never allowed to vanish into a few pixels.
  {
    const ground = pt(ball.pos.x, ball.pos.y)
    const air = pt(ball.pos.x, ball.pos.y, ball.lift * FLIGHT_HEIGHT + 0.35)
    if (ground.depth > NEAR) {
      const rx = Math.max(BALL_MIN_PX, air.scale * 0.55)
      entities.push({
        depth: ground.depth - 0.01,
        node: (
          <g key="ball">
            {ball.lift > 0.05 && <ellipse cx={ground.sx} cy={ground.sy} rx={rx} ry={rx * 0.4} fill="rgba(0,0,0,0.4)" />}
            <g transform={`translate(${air.sx} ${air.sy})`}>
              <ellipse rx={rx + 2.5} ry={rx * 0.62 + 2.5} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth={2} />
              <ellipse rx={rx} ry={rx * 0.62} fill="#9a5424" stroke="#2c1608" strokeWidth={1.5} />
              <line x1={-rx * 0.45} x2={rx * 0.45} y1={0} y2={0} stroke="#fff" strokeWidth={1.5} />
            </g>
          </g>
        ),
      })
    }
  }

  entities.sort((a, b) => b.depth - a.depth)

  return (
    <svg className="board field-view" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}>
      <defs>
        <marker id="arrow-p" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
        </marker>
      </defs>
      <Turf cam={cam} losYard={losYard} lineToGain={lineToGain} />

      {/* Paths lie on the turf */}
      {players
        .filter((p) => schedule.has(p.id) && pathVisible(p))
        .map((p) => {
          const s = schedule.get(p.id)!
          const extended = s.drawnLength < s.length
          const drawn = projectPolyline(extended ? s.pts.slice(0, -1) : s.pts, cam, false, PATH_NEAR)
          const isSel = p.id === selectedId
          if (drawn.length < 2) return null
          return (
            <g key={`path-${p.id}`}>
              <polyline
                points={pointsAttr(drawn)}
                fill="none"
                stroke={isSel ? 'var(--accent)' : sideStroke(p.side)}
                strokeWidth={isSel ? 4 : 3}
                strokeDasharray={p.timing === 'pre-snap' ? '2 6' : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
                markerEnd={extended ? undefined : 'url(#arrow-p)'}
              />
              {extended && (() => {
                const ext = projectPolyline(s.pts.slice(-2), cam, false, PATH_NEAR)
                return ext.length < 2 ? null : <polyline points={pointsAttr(ext)} fill="none" stroke={isSel ? 'var(--accent)' : sideStroke(p.side)} strokeWidth={2} strokeDasharray="4 5" opacity={0.6} />
              })()}
            </g>
          )
        })}

      {releasePoint && (() => {
        const v = pt(releasePoint.x, releasePoint.y)
        return v.depth > NEAR ? <rect x={-5} y={-5} width={10} height={10} transform={`translate(${v.sx} ${v.sy}) rotate(45)`} fill={releaseIsManual ? '#4da3ff' : '#0f1012'} stroke={releaseIsManual ? '#0f1012' : '#4da3ff'} strokeWidth={2} /> : null
      })()}
      {catchPoint && (() => {
        const v = pt(catchPoint.x, catchPoint.y)
        return v.depth > NEAR ? (
          <g transform={`translate(${v.sx} ${v.sy})`}>
            <ellipse rx={Math.max(6, v.scale * 0.6)} ry={Math.max(3, v.scale * 0.25)} fill="none" stroke="var(--accent)" strokeWidth={2} />
            <circle r={2.5} fill="var(--accent)" />
          </g>
        ) : null
      })()}

      {/* Engaged pairs: a short bar on the turf between them, drawn with the nearer of the two */}
      {links.map((l) => {
        const seg = projectPolyline([l.a, l.b], cam)
        if (seg.length < 2) return null
        const mid = seg[0]
        return (
          <g key={`link-${l.id}`}>
            <polyline points={pointsAttr(seg)} fill="none" stroke="#ff8c42" strokeWidth={Math.max(3, Math.min(10, mid.scale * 0.22))} strokeLinecap="round" opacity={0.9} />
            {l.since < 0.5 && <ellipse cx={(seg[0].sx + seg[1].sx) / 2} cy={(seg[0].sy + seg[1].sy) / 2} rx={(0.6 + l.since * 2) * mid.scale} ry={(0.6 + l.since * 2) * mid.scale * 0.35} fill="none" stroke="#ff8c42" strokeWidth={2.5} opacity={1 - l.since * 2} />}
          </g>
        )
      })}

      {entities.map((e) => e.node)}

      {/* Coach's teaching marks, on the turf */}
      {strokes.map((s, i) => {
        const seg = projectPolyline(s, cam, false, PATH_NEAR)
        return seg.length < 2 ? null : <polyline key={`tele-${i}`} points={pointsAttr(seg)} fill="none" stroke="#fff27a" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" opacity={0.95} />
      })}
    </svg>
  )
}
