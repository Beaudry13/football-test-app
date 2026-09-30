import { beforeEach, describe, expect, it } from 'vitest'
import { createMotionLabSession, type MotionLabSession } from './apiPlayRepository'
import { fakeMotionServer, memoryDraftStore, settle } from './testing/fakeMotionApi'
import { panePlays } from '../__characterization__/fixtures'
import { SCHEMA_VERSION, type Play } from '../engine/play'
import type { Player, StanceId } from '../engine/formation'
import { withStance } from '../authoring/stances'

/**
 * THE STANCE THROUGH THE SERVER (V6) - the sender half. The receiver half is
 * backend/tests/test_motion_lab.py::TestPresnapStance, which posts this same
 * shape to the real route. Every editor test uses the local repository, so
 * these are the tests that send the real document the real way: saved at
 * version 3, kept by the server, read back by a fresh session exactly - and a
 * cleared stance is an ABSENT key, never a null the server would refuse.
 */

const SCOPE = '7:3'
let server: ReturnType<typeof fakeMotionServer>
let drafts: ReturnType<typeof memoryDraftStore>
const start = (): MotionLabSession =>
  createMotionLabSession({ plays: server.playRows(), looks: server.lookRows(), draftScope: SCOPE, api: server.api, drafts })

const base = () => panePlays().find((p) => p.name === 'Inside Zone Rt')!
const stanced = (play: Play, stances: Record<string, StanceId | undefined>): Play => ({
  ...play,
  updatedAt: play.updatedAt + 1,
  players: play.players.map((p) => (p.id in stances ? withStance(p, stances[p.id]) : p)),
})
const docPlayers = () => ([...server.plays.values()][0].document as { players: Player[] }).players

beforeEach(() => {
  server = fakeMotionServer()
  drafts = memoryDraftStore()
})

describe('a stance saved to the server', () => {
  it('is sent as written, at version 3, and a man without one is sent without the key', async () => {
    const session = start()
    session.repository.savePlay(stanced(base(), { O0: 'OL_2_POINT', D2: 'DL_4_POINT' }))
    await settle()
    const body = server.calls[0].body as { schema_version: number }
    expect(body.schema_version).toBe(SCHEMA_VERSION)
    expect(SCHEMA_VERSION).toBe(3)
    const sent = docPlayers()
    expect(sent.find((p) => p.id === 'O0')!.presnapStance).toBe('OL_2_POINT')
    expect(sent.find((p) => p.id === 'D2')!.presnapStance).toBe('DL_4_POINT')
    expect(sent.filter((p) => 'presnapStance' in p)).toHaveLength(2)
  })

  it('comes back exactly in a fresh session - a reload, a second device', async () => {
    start().repository.savePlay(stanced(base(), { O0: 'OL_2_POINT', O1: 'OL_3_POINT_RIGHT', O2: 'CENTER_STANCE', O6: 'QB_SHOTGUN', O8: 'WR_STAGGERED', D2: 'DL_4_POINT', D7: 'DB_PRESS', D9: 'DB_SAFETY' }))
    await settle()
    const reopened = start().repository.listPlays()[0]
    const stances = Object.fromEntries(reopened.players.filter((p) => p.presnapStance).map((p) => [p.id, p.presnapStance]))
    expect(stances).toEqual({ O0: 'OL_2_POINT', O1: 'OL_3_POINT_RIGHT', O2: 'CENTER_STANCE', O6: 'QB_SHOTGUN', O8: 'WR_STAGGERED', D2: 'DL_4_POINT', D7: 'DB_PRESS', D9: 'DB_SAFETY' })
  })

  it('cleared, it is gone from the stored document - not null, not the default', async () => {
    const session = start()
    const play = stanced(base(), { O0: 'OL_2_POINT' })
    session.repository.savePlay(play)
    await settle()
    session.repository.savePlay(stanced(play, { O0: undefined }))
    await settle()
    expect(server.calls.map((c) => c.kind)).toEqual(['create', 'save'])
    const lt = docPlayers().find((p) => p.id === 'O0')!
    expect('presnapStance' in lt).toBe(false)
    expect('presnapStance' in start().repository.listPlays()[0].players[0]).toBe(false)
  })

  it('an older play saved again without touching a stance gains none', async () => {
    const session = start()
    session.repository.savePlay(base())
    await settle()
    session.repository.savePlay({ ...base(), name: 'Inside Zone Rt 2', updatedAt: base().updatedAt + 1 })
    await settle()
    expect(docPlayers().some((p) => 'presnapStance' in p)).toBe(false)
  })
})
