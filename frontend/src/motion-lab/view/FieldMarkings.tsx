import { FIELD_WIDTH, HASH_LEFT, HASH_RIGHT, MARGIN_X, U, Y_MAX, Y_MIN, toView, yardLabel } from '../engine/field'

interface Props {
  /** Yards from the offense's own goal line at the LOS; drives the numbers on the field. */
  losYard: number
  /** Field y of the line to gain (or the goal line), null to draw none. */
  lineToGain: number | null
}

/** Static overhead field: turf, yard lines, hashes, numbers, LOS, line to gain. */
export function FieldMarkings({ losYard, lineToGain }: Props) {
  const yardLines: number[] = []
  const ticks: number[] = []
  for (let y = Y_MIN; y <= Y_MAX; y++) {
    const abs = losYard + y
    if (abs < 0 || abs > 100) continue
    if (abs % 5 === 0) yardLines.push(y)
    else ticks.push(y)
  }
  const goalY = 100 - losYard
  const ownGoalY = -losYard

  const left = toView({ x: 0, y: 0 }).x
  const right = toView({ x: FIELD_WIDTH, y: 0 }).x
  const top = toView({ x: 0, y: Y_MAX }).y
  const bottom = toView({ x: 0, y: Y_MIN }).y
  const yOf = (y: number) => toView({ x: 0, y }).y

  return (
    <g className="field">
      {/* Out of bounds + turf */}
      <rect x={-MARGIN_X * U} y={0} width={(FIELD_WIDTH + 2 * MARGIN_X) * U} height={(Y_MAX - Y_MIN) * U} fill="#131a15" />
      <rect x={left} y={top} width={right - left} height={bottom - top} fill="#1d3b2a" />

      {/* Alternating 5-yard bands for depth */}
      {yardLines.map((y) =>
        Math.floor((losYard + y) / 5) % 2 === 0 ? (
          <rect key={`band${y}`} x={left} y={yOf(Math.min(y + 5, Y_MAX))} width={right - left} height={(Math.min(y + 5, Y_MAX) - y) * U} fill="#1f402d" />
        ) : null,
      )}

      {/* End zones, if the window reaches them */}
      {goalY <= Y_MAX && <rect x={left} y={top} width={right - left} height={yOf(goalY) - top} fill="#2a2440" opacity={0.8} />}
      {ownGoalY >= Y_MIN && <rect x={left} y={yOf(ownGoalY)} width={right - left} height={bottom - yOf(ownGoalY)} fill="#2a2440" opacity={0.8} />}

      {/* Yard lines */}
      {yardLines.map((y) => (
        <line key={`yl${y}`} x1={left} x2={right} y1={yOf(y)} y2={yOf(y)} stroke="rgba(255,255,255,0.55)" strokeWidth={losYard + y === 50 ? 3 : 2} />
      ))}

      {/* One-yard ticks at sidelines and hashes */}
      {ticks.map((y) => {
        const vy = yOf(y)
        const w = 0.6 * U
        return (
          <g key={`tk${y}`} stroke="rgba(255,255,255,0.45)" strokeWidth={1.5}>
            <line x1={left} x2={left + w} y1={vy} y2={vy} />
            <line x1={right - w} x2={right} y1={vy} y2={vy} />
            <line x1={HASH_LEFT * U - w / 2} x2={HASH_LEFT * U + w / 2} y1={vy} y2={vy} />
            <line x1={HASH_RIGHT * U - w / 2} x2={HASH_RIGHT * U + w / 2} y1={vy} y2={vy} />
          </g>
        )
      })}

      {/* Yard numbers, rotated to read from each sideline */}
      {yardLines.map((y) => {
        const label = yardLabel(y, losYard)
        if (!label) return null
        const vy = yOf(y)
        return (
          <g key={`num${y}`} fill="rgba(255,255,255,0.35)" fontSize={2.2 * U} fontWeight={700} fontFamily="Inter, system-ui, sans-serif">
            <text transform={`translate(${7 * U} ${vy}) rotate(90)`} textAnchor="middle" dominantBaseline="middle">
              {label}
            </text>
            <text transform={`translate(${(FIELD_WIDTH - 7) * U} ${vy}) rotate(-90)`} textAnchor="middle" dominantBaseline="middle">
              {label}
            </text>
          </g>
        )
      })}

      {/* Sidelines */}
      <line x1={left} x2={left} y1={top} y2={bottom} stroke="#fff" strokeWidth={4} />
      <line x1={right} x2={right} y1={top} y2={bottom} stroke="#fff" strokeWidth={4} />

      {/* Line to gain: restrained, not a broadcast graphic */}
      {lineToGain !== null && lineToGain > 0 && lineToGain <= Y_MAX && (
        <line x1={left} x2={right} y1={yOf(lineToGain)} y2={yOf(lineToGain)} stroke="#f7c948" strokeWidth={2} opacity={0.7} />
      )}

      {/* Line of scrimmage */}
      <line x1={left} x2={right} y1={yOf(0)} y2={yOf(0)} stroke="#4da3ff" strokeWidth={2.5} strokeDasharray="10 6" opacity={0.9} />
    </g>
  )
}
