// WHERE MOTION LAB PLAYS AND LOOKS LIVE - the editor's only view of storage.
//
// The editor asks for exactly these operations and never learns what answers
// them. P1 answers with the browser (LocalPlayRepository); P2 replaces that
// with PEIRA's server without the authoring UI knowing.
//
// SYNCHRONOUS ON PURPOSE, FOR NOW. These are the calls the validated prototype
// makes, with the timing it makes them: "save, then list", and a final flush
// from `pagehide` that cannot wait for a promise. Making them async is a
// behaviour change to autosave, and belongs to the phase that has a network
// to be async about - P2 - not to the move. Recorded as a P2 design task.
//
// What crosses this boundary is COACH INTENT ONLY - `Play` and `Look` as
// defined in engine/play.ts. Schedules, ball frames, orientation, camera and
// playback position are derived on open and never stored.

import type { Look, Play } from '../engine/play'

export interface PlayRepository {
  /** False when nothing can be persisted (storage blocked or full). */
  available(): boolean

  /** Every play, most recently updated first, each already sanitized. */
  listPlays(): Play[]
  /** Insert or replace by id. False when the write did not happen. */
  savePlay(play: Play): boolean
  deletePlay(id: string): boolean

  /** Every saved look, most recently updated first, each already sanitized. */
  listLooks(): Look[]
  saveLook(look: Look): boolean
  deleteLook(id: string): boolean

  /** The play that was open last, so the editor reopens where the coach left. */
  currentPlayId(): string | null
  setCurrentPlayId(id: string | null): void
}
