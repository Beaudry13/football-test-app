// WHAT THE LETTERS MEAN.
//
// A coach reads "FS" at a glance; somebody new to football reads two letters.
// The selected player's chip spells the position out - only there, only once
// he is picked - so the field itself keeps its short labels and nothing on it
// gets more crowded. A label the coach made up (12, Q, "Rover") has no name
// here and simply shows as itself.

const NAMES: Record<string, string> = {
  QB: 'Quarterback',
  RB: 'Running back',
  TB: 'Tailback',
  HB: 'Halfback',
  FB: 'Fullback',
  X: 'Receiver',
  Z: 'Receiver',
  WR: 'Receiver',
  H: 'Slot receiver',
  SL: 'Slot receiver',
  Y: 'Tight end',
  U: 'Tight end',
  TE: 'Tight end',
  LT: 'Left tackle',
  LG: 'Left guard',
  C: 'Center',
  RG: 'Right guard',
  RT: 'Right tackle',
  OL: 'Offensive lineman',
  DE: 'Defensive end',
  DT: 'Defensive tackle',
  NT: 'Nose tackle',
  DL: 'Defensive lineman',
  LB: 'Linebacker',
  ILB: 'Inside linebacker',
  OLB: 'Outside linebacker',
  MLB: 'Middle linebacker',
  MIKE: 'Middle linebacker',
  SAM: 'Strong-side linebacker',
  WILL: 'Weak-side linebacker',
  CB: 'Cornerback',
  NB: 'Nickel back',
  DB: 'Defensive back',
  FS: 'Free safety',
  SS: 'Strong safety',
  S: 'Safety',
}

/** "FS" -> "Free safety"; a numbered copy ("CB2") reads as its position; anything else -> null. */
export function positionName(label: string): string | null {
  const key = label.trim().toUpperCase().replace(/\d+$/, '')
  return NAMES[key] ?? null
}
