// Field coordinates → a pinhole camera anywhere on (or above) the field.
//
// This is the ONLY place that knows a perspective view exists. It takes the
// same yards every other part of the prototype uses and returns screen
// positions plus a depth for draw ordering. Nothing upstream stores anything
// from here. z is height above the turf in yards (0 for everything except a
// ball in flight and the cameras themselves).

import type { Pt } from './geometry'

export interface Camera {
  /** Camera position in field yards. */
  x: number
  y: number
  /** Height above the turf, yards. */
  h: number
  /** Unit vector in the field plane the camera looks along. */
  look: Pt
  /** Downward tilt, radians. */
  pitch: number
  /** Horizontal field of view, radians. */
  fov: number
  /** Where the view axis lands on screen (0..1 of the height). */
  centerY: number
}

export const VIEW_W = 1000
export const VIEW_H = 560

/** Anything closer than this to the camera plane is behind/at the lens and is not drawn. */
export const NEAR = 1.2

const deg = (d: number) => (d * Math.PI) / 180

/**
 * COACH: behind the defense, up high, tilted well down. Close and steep
 * rather than far and shallow - that is what keeps thirty yards of depth
 * from collapsing into a stripe.
 */
export const COACH_CAMERA: Camera = {
  x: 53.33 / 2,
  y: 30,
  h: 20,
  look: { x: 0, y: -1 },
  pitch: deg(40),
  fov: deg(75),
  centerY: 0.54,
}

// PLAYER: over the shoulder of a real player, a touch above helmet height so
// the near players don't wall off the picture. Follows him every frame.
const PLAYER_EYE = 4.6
const PLAYER_BACK = 1.2
const PLAYER_PITCH = deg(17)
const PLAYER_FOV = deg(82)

/** Engaged: step the camera back so the man you are on is in the picture, not under your chin. */
const PLAYER_BACK_ENGAGED = 3.2

export function playerCamera(pos: Pt, look: Pt, engaged = false): Camera {
  const back = engaged ? PLAYER_BACK_ENGAGED : PLAYER_BACK
  return {
    x: pos.x - look.x * back,
    y: pos.y - look.y * back,
    h: PLAYER_EYE,
    look,
    pitch: PLAYER_PITCH,
    fov: PLAYER_FOV,
    centerY: 0.47,
  }
}

export interface Projected {
  sx: number
  sy: number
  /** Distance along the camera's view axis; larger = farther. */
  depth: number
  /** Screen pixels per field yard at this depth. */
  scale: number
}

export const focal = (cam: Camera) => VIEW_W / 2 / Math.tan(cam.fov / 2)

/** Camera-space coordinates: depth along the view axis, right, up. */
function toCamera(p: Pt, cam: Camera, z: number) {
  const cosP = Math.cos(cam.pitch)
  const sinP = Math.sin(cam.pitch)
  const rx = p.x - cam.x
  const ry = p.y - cam.y
  const rz = z - cam.h
  // Forward tilts down by pitch; up tilts forward by the same; right is the
  // look direction rotated clockwise (looking along -y, right is -x).
  const depth = (rx * cam.look.x + ry * cam.look.y) * cosP - rz * sinP
  const up = (rx * cam.look.x + ry * cam.look.y) * sinP + rz * cosP
  const right = rx * cam.look.y - ry * cam.look.x
  return { depth, up, right }
}

export function project(p: Pt, cam: Camera, z = 0): Projected {
  const fl = focal(cam)
  const { depth, up, right } = toCamera(p, cam, z)
  const scale = fl / depth
  return { sx: VIEW_W / 2 + right * scale, sy: VIEW_H * cam.centerY - up * scale, depth, scale }
}

/** Screen y of the horizon: where the ground plane vanishes. */
export function horizonY(cam: Camera): number {
  return VIEW_H * cam.centerY - focal(cam) * Math.tan(cam.pitch)
}

/**
 * Project a polyline (or closed polygon) on the turf, clipping it against
 * the near plane so segments that pass behind the camera don't smear
 * across the screen. Depth is linear in field coordinates, so the clip
 * point is a plain interpolation.
 */
export function projectPolyline(pts: Pt[], cam: Camera, closed = false, near = NEAR): Projected[] {
  const n = pts.length
  if (n === 0) return []
  const cams = pts.map((p) => ({ p, d: toCamera(p, cam, 0).depth }))
  const out: Projected[] = []
  for (let i = 0; i < n; i++) {
    const cur = cams[i]
    if (cur.d > near) out.push(project(cur.p, cam))
    const nxt = i < n - 1 ? cams[i + 1] : closed ? cams[0] : null
    if (nxt && cur.d > near !== nxt.d > near) {
      const t = (near - cur.d) / (nxt.d - cur.d)
      out.push(project({ x: cur.p.x + (nxt.p.x - cur.p.x) * t, y: cur.p.y + (nxt.p.y - cur.p.y) * t }, cam))
    }
  }
  return out
}

export const pointsAttr = (vs: { sx: number; sy: number }[]) => vs.map((v) => `${v.sx.toFixed(1)},${v.sy.toFixed(1)}`).join(' ')
