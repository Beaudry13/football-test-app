// THE OVERHEAD BOARD - the field a play is authored and taught on, as a view.
//
// Extracted from the prototype editor's inline SVG with its markup unchanged
// (pinned by authoring/overheadMarkup.test.tsx). It owns NO state: it is given
// the play, what the engine derived from it, the moment to draw, and how to
// present it, and draws exactly that.
//
// Everything under "authoring overlays" is optional. The editor passes them;
// a read-only board - a library preview, a teaching page - simply leaves them
// out, and gets the same field, paths, ball and markers the editor shows.
//
// Colours are CSS custom properties (--accent, --offense, ...) declared on the
// Motion Lab root, so the board must be rendered inside that root.

import type { PointerEventHandler, Ref } from 'react'
import { FieldMarkings } from './FieldMarkings'
import { VIEWBOX, U, Y_MAX, toView } from '../engine/field'
import type { Player } from '../engine/formation'
import type { Pt } from '../engine/geometry'
import { posAt, type ScheduleMap } from '../engine/timeline'
import { isPass, type BallAction, type BallTimeline } from '../engine/ball'
import { orientationAt, type OrientationMap } from '../engine/orientation'
import type { DerivedEngagement, Engagement } from '../engine/interactions'

const PLAYER_R = 0.85 * U

/**
 * THE GOLD ROUTE HANDLE - "drag me and I'll draw this man's assignment".
 *
 * Measured from the marker's centre, in viewBox units (U = 20 per yard):
 *
 *   17  the marker's edge
 *   23  the selection ring (stroke 3, so it ends at 24.5)
 *   28  the stub starts - clear of the ring, so the two never touch
 *   44  the stub ends and the arrowhead begins
 *   58  the point
 *
 * The design put the stub at 19, which would have run straight through the
 * selection ring; moving that one number out to 28 is the whole adjustment.
 * The stub is thinner than the marker's own stroke and carries no label, so
 * it reads as something attached to the man rather than a second man.
 */
const HANDLE = { stub: 28, head: 44, tip: 58, hit: 26, halfWidth: 14, headHalf: 7 }

/**
 * Which way the handle points: downfield, which is up the screen.
 *
 * Flipped back toward the offense for a man standing within 2.5 yd of the top
 * of the coaching window, where a downfield handle would hang off the board.
 * Both sides of the ball get the same default, per SPEC §5.2 and its §17.1
 * note to revisit it after coaches have used it.
 */
const handlePointsBack = (y: number) => y > Y_MAX - 2.5

function RouteHandle({ id, y }: { id: string; y: number }) {
  const back = handlePointsBack(y)
  return (
    <g data-handle={id} className="route-handle" transform={back ? 'scale(1 -1)' : undefined}>
      {/* Hit area first, and invisible: generous to grab, never drawn. */}
      <rect x={-HANDLE.halfWidth} y={-HANDLE.tip} width={HANDLE.halfWidth * 2} height={HANDLE.tip - HANDLE.hit} fill="transparent" />
      <circle cy={-HANDLE.tip} r={HANDLE.headHalf} fill="transparent" />
      <line x1={0} y1={-HANDLE.stub} x2={0} y2={-HANDLE.head} stroke="var(--accent)" strokeWidth={4} strokeLinecap="round" />
      <path d={`M ${-HANDLE.headHalf} ${-HANDLE.head} L ${HANDLE.headHalf} ${-HANDLE.head} L 0 ${-HANDLE.tip} Z`} fill="var(--accent)" />
    </g>
  )
}

const pointsAttr = (pts: Pt[]) =>
  pts
    .map((q) => {
      const v = toView(q)
      return `${v.x},${v.y}`
    })
    .join(' ')

export interface OverheadBoardProps {
  // ---- the play (coach intent) ----
  players: Player[]
  ball: BallAction | null
  engagements: Engagement[]
  /** Yards from the offense's own goal at the LOS (field numbering). */
  losYard: number
  /** Field y of the line to gain, or null. */
  lineToGain: number | null

  // ---- derived by the engine ----
  /** The schedule the play runs on (after the ball's continuation). */
  schedule: ScheduleMap
  /** The schedule as drawn (after engagements, before continuation). */
  drawnSchedule: ScheduleMap
  snapAt: number
  ballTimeline: BallTimeline
  engaged: DerivedEngagement[]
  orientation: OrientationMap

  // ---- the moment and the presentation ----
  time: number
  showLabels: boolean
  pathVisible: (p: Player) => boolean
  selectedId: string | null
  /** Teaching mode: authoring markers are hidden. */
  present: boolean
  /** Telestration marks, field yards. */
  strokes: Pt[][]

  // ---- authoring overlays (optional; a read-only board omits them) ----
  className?: string
  svgRef?: Ref<SVGSVGElement>
  onPointerDown?: PointerEventHandler<SVGSVGElement>
  onPointerMove?: PointerEventHandler<SVGSVGElement>
  onPointerUp?: PointerEventHandler<SVGSVGElement>
  onPointerLeave?: PointerEventHandler<SVGSVGElement>
  /** Edit Path handles are drawn for the selected player. */
  editingPath?: boolean
  /**
   * Draw the selected player's gold route handle - the grab point that starts
   * his assignment. Authoring only: a read-only board omits it and gets the
   * same field it always drew.
   */
  showRouteHandle?: boolean
  /** A route being drawn right now. */
  draft?: Pt[] | null
  /** An in-progress telestration mark. */
  teleDraft?: Pt[] | null
  /** Where a catch/release pick would land under the pointer. */
  hoverCatch?: Pt | null
  /** The receiver (or QB) whose route a catch/release is being picked on. */
  catchTargetId?: string | null
  /** May this player be clicked at the current setup step? */
  isPickable?: (p: Player) => boolean
  /** Is this player stepped back while a setup step is in progress? */
  isDimmed?: (p: Player) => boolean
}

const never = () => false

export function OverheadBoard({
  players,
  ball,
  engagements,
  losYard,
  lineToGain,
  schedule,
  drawnSchedule,
  snapAt,
  ballTimeline,
  engaged,
  orientation,
  time,
  showLabels,
  pathVisible,
  selectedId,
  present,
  strokes,
  className = 'board',
  svgRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerLeave,
  editingPath = false,
  showRouteHandle = false,
  draft = null,
  teleDraft = null,
  hoverCatch = null,
  catchTargetId = null,
  isPickable = never,
  isDimmed = never,
}: OverheadBoardProps) {
  // The same derivations the editor made inline, from the same inputs.
  const positionAt = (p: Player, t: number): Pt => posAt(schedule, p, t)
  const ballFrame = ballTimeline.at(time)
  const qbId = players.find((p) => p.side === 'offense' && p.label === 'QB')?.id
  const selected = players.find((p) => p.id === selectedId) ?? null
  const qbHasPath = !!qbId && schedule.has(qbId)
  const hasReleaseOverride = isPass(ball) && !!ball.releasePoint
  const adjustedKey = ballTimeline.catchAdjusted ? `${ballTimeline.catchPoint!.x.toFixed(1)},${ballTimeline.catchPoint!.y.toFixed(1)}` : ''
  // Pairs that are engaged at this instant, for the link drawn between them.
  const engagedNow = engaged
    .filter((d) => d.valid && d.time !== null && time >= d.time && (d.until === null || time < d.until))
    .map((d) => ({ id: d.id, a: positionAt(players.find((p) => p.id === d.a)!, time), b: positionAt(players.find((p) => p.id === d.b)!, time), since: time - d.time! }))

  const ballV = toView(ballFrame.pos)
  const ballScale = 1 + 0.8 * ballFrame.lift
  const catchMarker = ballTimeline.catchPoint

  return (
        <svg
          ref={svgRef}
          className={className}
          viewBox={VIEWBOX}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
        >
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>

          <FieldMarkings losYard={losYard} lineToGain={lineToGain} />

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
            const canPick = isPickable(p)
            const dim = isDimmed(p)
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
                {isSel && showRouteHandle && !present && <RouteHandle id={p.id} y={positionAt(p, time).y} />}
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
            const o = orientationAt(orientation, selected, time)
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
            editingPath &&
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
  )
}
