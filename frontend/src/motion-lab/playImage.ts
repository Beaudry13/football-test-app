// A PLAY AS A PICTURE (Motion Lab -> quiz question).
//
// Draws a Motion Lab play as a clean overhead diagram on a canvas: the field
// window the editor shows (13 yards behind the line, 17 past it), yard lines,
// hashes, the line of scrimmage and the line to gain, every man as a labelled
// circle at his alignment and - only when asked - the routes and motion. A
// "draw your assignment" question wants the formation WITHOUT the answer, so
// routes are off unless the coach turns them on.
//
// Drawn from the play's data, not copied from the editor's SVG, so it never
// depends on the editor's stylesheet, selection or playback position.

import { FIELD_WIDTH, HASH_LEFT, HASH_RIGHT, Y_MAX, Y_MIN } from './engine/field'
import type { Player } from './engine/formation'
import type { Pt } from './engine/geometry'
import { lineToGainY, type Play } from './engine/play'
import { IMAGE_HEIGHT, IMAGE_WIDTH, px, U } from './playImageLayout'

export { IMAGE_HEIGHT, IMAGE_WIDTH } from './playImageLayout'

export interface PlayImageOptions {
  /** Draw each man's route and pre-snap motion. */
  routes: boolean
  /** Draw the pre-snap motion WITHOUT the routes ("#3 motions across - your
   *  check?"). Implied by `routes`. */
  motion?: boolean
  /** The man the question is about ("You're the X"): ringed in gold. */
  highlight?: string | null
  /** Draw the football at the snapper's feet (false once it has been snapped). */
  ball?: boolean
}

const COLORS = {
  grass: '#2e6b3c',
  stripe: '#2a6237',
  line: 'rgba(255,255,255,0.75)',
  los: '#4ea1ff',
  toGain: '#f7c948',
  offense: '#f2f2ee',
  offenseInk: '#16181b',
  defense: '#e2573a',
  defenseInk: '#ffffff',
  route: '#f7c948',
  defenseRoute: '#ff9b85',
  ball: '#8a4b20',
  highlight: '#f7c948',
}

function arrowHead(ctx: CanvasRenderingContext2D, from: Pt, to: Pt) {
  const a = px(from)
  const b = px(to)
  const ang = Math.atan2(b.y - a.y, b.x - a.x)
  const len = 0.55 * U
  ctx.beginPath()
  ctx.moveTo(b.x, b.y)
  ctx.lineTo(b.x - len * Math.cos(ang - 0.45), b.y - len * Math.sin(ang - 0.45))
  ctx.lineTo(b.x - len * Math.cos(ang + 0.45), b.y - len * Math.sin(ang + 0.45))
  ctx.closePath()
  ctx.fill()
}

function line(ctx: CanvasRenderingContext2D, pts: Pt[], dashed: boolean) {
  if (pts.length < 2) return
  ctx.setLineDash(dashed ? [0.35 * U, 0.3 * U] : [])
  ctx.beginPath()
  pts.forEach((p, i) => {
    const q = px(p)
    if (i === 0) ctx.moveTo(q.x, q.y)
    else ctx.lineTo(q.x, q.y)
  })
  ctx.stroke()
  ctx.setLineDash([])
}

function drawRoutes(ctx: CanvasRenderingContext2D, players: Player[], routes = true) {
  ctx.lineWidth = 0.16 * U
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const p of players) {
    const color = p.side === 'offense' ? COLORS.route : COLORS.defenseRoute
    ctx.strokeStyle = color
    ctx.fillStyle = color
    const motion = p.motion ?? []
    if (motion.length >= 2) line(ctx, motion, true)
    if (routes && p.path.length >= 2) {
      line(ctx, p.path, false)
      arrowHead(ctx, p.path[p.path.length - 2], p.path[p.path.length - 1])
    } else if (motion.length >= 2) {
      arrowHead(ctx, motion[motion.length - 2], motion[motion.length - 1])
    }
  }
}

/** Draws `play` onto a context sized IMAGE_WIDTH x IMAGE_HEIGHT. */
export function drawPlay(ctx: CanvasRenderingContext2D, play: Play, options: PlayImageOptions) {
  const { losYard } = play.situation
  // Grass, mown in five-yard stripes.
  ctx.fillStyle = COLORS.grass
  ctx.fillRect(0, 0, IMAGE_WIDTH, IMAGE_HEIGHT)
  for (let y = Math.ceil(Y_MIN); y < Y_MAX; y++) {
    if (((losYard + y) % 10 + 10) % 10 < 5) {
      ctx.fillStyle = COLORS.stripe
      ctx.fillRect(0, (Y_MAX - y - 1) * U, IMAGE_WIDTH, U)
    }
  }
  // Sidelines, yard lines every five yards, hashes every yard.
  ctx.strokeStyle = COLORS.line
  ctx.lineWidth = 2
  for (const x of [0, FIELD_WIDTH]) {
    const a = px({ x, y: Y_MIN })
    const b = px({ x, y: Y_MAX })
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
  ctx.font = `bold ${Math.round(1.6 * U)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (let y = Math.ceil(Y_MIN); y <= Math.floor(Y_MAX); y++) {
    const abs = losYard + y
    if (abs <= 0 || abs >= 100) continue
    if (abs % 5 === 0) {
      const a = px({ x: 0, y })
      const b = px({ x: FIELD_WIDTH, y })
      ctx.lineWidth = abs % 10 === 0 ? 2.5 : 1.5
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
      if (abs % 10 === 0) {
        const label = String(abs > 50 ? 100 - abs : abs)
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        for (const x of [7, FIELD_WIDTH - 7]) {
          const q = px({ x, y })
          ctx.fillText(label, q.x, q.y)
        }
      }
    }
    ctx.lineWidth = 1.5
    for (const x of [HASH_LEFT, HASH_RIGHT]) {
      const a = px({ x: x - 0.4, y })
      const b = px({ x: x + 0.4, y })
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
  }
  // The line of scrimmage, and the line to gain when the play shows one.
  const rule = (y: number, color: string) => {
    const a = px({ x: 0, y })
    const b = px({ x: FIELD_WIDTH, y })
    ctx.strokeStyle = color
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }
  rule(0, COLORS.los)
  const toGain = lineToGainY(play.situation)
  if (toGain !== null && toGain < Y_MAX) rule(toGain, COLORS.toGain)

  if (options.routes) drawRoutes(ctx, play.players)
  else if (options.motion) drawRoutes(ctx, play.players, false)

  // The football, at the snapper's feet.
  const snapper = play.players.find((p) => p.side === 'offense' && p.role === 'snapper') ?? play.players.find((p) => p.side === 'offense' && p.label === 'C')
  if (snapper && options.ball !== false) {
    const b = px({ x: snapper.x, y: 0 })
    ctx.fillStyle = COLORS.ball
    ctx.beginPath()
    ctx.ellipse(b.x, b.y, 0.32 * U, 0.2 * U, 0, 0, Math.PI * 2)
    ctx.fill()
  }

  // The men: a circle each, labelled.
  ctx.font = `bold ${Math.round(0.72 * U)}px system-ui, sans-serif`
  for (const p of play.players) {
    const c = px(p)
    const offense = p.side === 'offense'
    ctx.fillStyle = offense ? COLORS.offense : COLORS.defense
    ctx.strokeStyle = 'rgba(0,0,0,0.55)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(c.x, c.y, 0.9 * U, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = offense ? COLORS.offenseInk : COLORS.defenseInk
    ctx.fillText(p.label, c.x, c.y + 1)
  }

  // The man the question is about, ringed so a player finds himself at a glance.
  const marked = options.highlight ? play.players.find((p) => p.id === options.highlight) : undefined
  if (marked) {
    const c = px(marked)
    ctx.strokeStyle = COLORS.highlight
    ctx.lineWidth = 0.24 * U
    ctx.beginPath()
    ctx.arc(c.x, c.y, 1.32 * U, 0, Math.PI * 2)
    ctx.stroke()
  }
}

/** The play as a PNG. Throws when the browser cannot draw (no canvas). */
export function playImage(play: Play, options: PlayImageOptions): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = IMAGE_WIDTH
  canvas.height = IMAGE_HEIGHT
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.reject(new Error('This browser cannot draw the play.'))
  drawPlay(ctx, play, options)
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The picture could not be made.'))), 'image/png'))
}
