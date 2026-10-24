/**
 * WHEN A PLAY WAS LAST TAUGHT from Motion Lab ("Teach a moment"), on this
 * device - so "Use this play" can answer "have I already used this to teach?".
 * Teach itself saves nothing to PEIRA; this is the coach's own reminder, kept
 * where his teaching notes are (TeachPlay), under the same play id.
 */
const key = (playId: string) => `peira.motionLab.taught.${playId}`

export function readTaught(playId: string): string | null {
  try {
    return localStorage.getItem(key(playId))
  } catch {
    return null
  }
}

export function rememberTaught(playId: string, at = new Date()): void {
  try {
    localStorage.setItem(key(playId), at.toISOString())
  } catch {
    // A private window: it just is not remembered.
  }
}
