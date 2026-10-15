import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client'
import { createMotionLabSession, peekScratch, RETRY_DELAYS, toDocument, type MotionLabSession } from './apiPlayRepository'
import { fakeMotionServer, memoryDraftStore, settle } from './testing/fakeMotionApi'
import { gapPlays } from '../__characterization__/fixtures'
import { lookFromPlayers, newPlay, SCHEMA_VERSION, type Play } from '../engine/play'

/**
 * THE SAVE LIFECYCLE, pinned. See apiPlayRepository.ts for the design these
 * tests hold it to: synchronous cache, one request per play at a time with the
 * latest version sent next, revisions on every save, a draft only while a save
 * is unconfirmed, conflicts that stop and ask, retries that say so.
 */

const SCOPE = '7:3'
let server: ReturnType<typeof fakeMotionServer>
let drafts: ReturnType<typeof memoryDraftStore>

function start(): MotionLabSession {
  return createMotionLabSession({ plays: server.playRows(), looks: server.lookRows(), draftScope: SCOPE, api: server.api, drafts })
}

const draftKeys = () => [...drafts.data.keys()]
const renamed = (play: Play, name: string): Play => ({ ...play, name, updatedAt: play.updatedAt + 1 })

beforeEach(() => {
  server = fakeMotionServer()
  drafts = memoryDraftStore()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('saving', () => {
  it('creates a new play, then saves it from the revision the server returned', async () => {
    const session = start()
    const play = gapPlays()[0]
    session.repository.savePlay(play)
    expect(session.repository.listPlays().map((p) => p.id)).toEqual([play.id]) // synchronous, before the network
    expect(session.stateOf(play.id).state).toBe('saving')
    await settle()
    expect(server.calls.map((c) => c.kind)).toEqual(['create'])
    expect((server.calls[0].body as { document: unknown }).document).toEqual(toDocument(play))
    expect(session.stateOf(play.id).state).toBe('saved')
    expect(draftKeys()).toEqual([])

    session.repository.savePlay(renamed(play, 'Toss Crack'))
    await settle()
    expect(server.calls[1]).toMatchObject({ kind: 'save', body: { name: 'Toss Crack', base_revision: 1 } })
    expect([...server.plays.values()][0].revision).toBe(2)
  })

  it('stores intent only: the document is the authored model, nothing derived', async () => {
    const session = start()
    session.repository.savePlay(gapPlays()[1])
    await settle()
    const sent = (server.calls[0].body as { document: Record<string, unknown> }).document
    expect(Object.keys(sent).sort()).toEqual(['ball', 'ballThen', 'engagements', 'filter', 'players', 'situation'])
  })

  it('sends Engagement.auto as PEIRA authored it, including the legacy absence', async () => {
    /**
     * THE SENDER HALF of the `auto` contract. The receiver half is
     * backend/tests/test_motion_lab.py::TestEngagementAuto, which posts this
     * same shape to the real route; the two together are why the field now
     * survives a save. They were written after an audit found the frontend
     * persisting `auto` into a validator that refused it - every editor test
     * uses the LOCAL repository, so no suite had ever sent the real document
     * to the real server.
     *
     * The third engagement is the one that matters most: a play written
     * before `auto` existed has no such key, and "no key" is how the editor
     * knows the coach owns that meeting point. Serializing it as `false`
     * would be a different claim.
     */
    const session = start()
    const base = gapPlays()[0]
    const engagements = [
      { id: 'e1', kind: 'engage' as const, a: 'O1', b: 'D1', point: { x: 7, y: 1 }, auto: true },
      { id: 'e2', kind: 'engage' as const, a: 'O2', b: 'D2', point: { x: 9, y: 2 }, auto: false },
      { id: 'e3', kind: 'engage' as const, a: 'O3', b: 'D3', point: { x: 11, y: 3 } },
    ]
    const play: Play = { ...base, engagements }
    session.repository.savePlay(play)
    await settle()

    const sent = (server.calls[0].body as { document: { engagements: Record<string, unknown>[] } }).document.engagements
    expect(sent.map((e) => e.auto)).toEqual([true, false, undefined])
    expect('auto' in sent[2]).toBe(false)
    expect(sent).toEqual(toDocument(play).engagements)
    expect(session.stateOf(play.id).state).toBe('saved')

    // And back out again: a second session reading the server's rows sees the
    // same three, through the sanitizer that older plays also come through.
    const reopened = createMotionLabSession({ plays: server.playRows(), looks: server.lookRows(), draftScope: SCOPE, api: server.api, drafts })
    const stored = reopened.repository.listPlays().find((p) => p.name === play.name)!.engagements
    expect(stored.map((e) => e.auto)).toEqual([true, false, undefined])
    expect('auto' in stored[2]).toBe(false)
  })

  it('coalesces edits made while a request is out into ONE follow-up carrying the latest', async () => {
    const session = start()
    const play = gapPlays()[0]
    server.hold()
    session.repository.savePlay(play)
    await settle()
    session.repository.savePlay(renamed(play, 'v2'))
    session.repository.savePlay(renamed(play, 'v3'))
    session.repository.savePlay(renamed(play, 'v4'))
    expect(server.calls).toHaveLength(1)
    server.release()
    await settle(20)
    expect(server.calls.map((c) => [c.kind, (c.body as { name: string }).name])).toEqual([
      ['create', play.name],
      ['save', 'v4'],
    ])
    expect(session.stateOf(play.id).state).toBe('saved')
  })

  it('an unchanged save sends nothing', async () => {
    const session = start()
    const play = gapPlays()[0]
    session.repository.savePlay(play)
    await settle()
    session.repository.savePlay({ ...play, updatedAt: play.updatedAt + 5000 })
    await settle()
    expect(server.calls).toHaveLength(1)
  })
})

describe('when a save cannot land', () => {
  async function saved(session: MotionLabSession) {
    const play = gapPlays()[0]
    session.repository.savePlay(play)
    await settle()
    return play
  }

  it('a play changed somewhere else stops sending and keeps the coach\'s version', async () => {
    const session = start()
    const play = await saved(session)
    server.editElsewhere(100, 'The DC renamed it')
    session.repository.savePlay(renamed(play, 'Mine'))
    await settle()
    expect(session.stateOf(play.id).state).toBe('conflict')
    expect(server.plays.get(100)!.name).toBe('The DC renamed it')
    expect(session.repository.listPlays()[0].name).toBe('Mine')
    session.repository.savePlay(renamed(play, 'Mine, again'))
    await settle()
    expect(server.calls.filter((c) => c.kind === 'save')).toHaveLength(1)
    expect(draftKeys()).toHaveLength(1)
  })

  it('a play deleted somewhere else is reported, not recreated', async () => {
    const session = start()
    const play = await saved(session)
    server.plays.delete(100)
    session.repository.savePlay(renamed(play, 'Mine'))
    await settle()
    expect(session.stateOf(play.id).state).toBe('deleted-elsewhere')
    expect(server.calls.filter((c) => c.kind === 'create')).toHaveLength(1)
  })

  it('a network failure retries with backoff, says so, and clears the draft once it lands', async () => {
    vi.useFakeTimers()
    const session = start()
    const play = gapPlays()[0]
    server.failNextWith(new ApiError('Could not reach the server.', 0))
    session.repository.savePlay(play)
    await settle()
    expect(session.stateOf(play.id).state).toBe('retrying')
    expect(draftKeys()).toHaveLength(1)
    server.failNextWith(new ApiError('Server error', 502))
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0])
    expect(session.stateOf(play.id).state).toBe('retrying')
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[1])
    expect(server.calls.map((c) => c.kind)).toEqual(['create', 'create', 'create'])
    expect(session.stateOf(play.id).state).toBe('saved')
    expect(draftKeys()).toEqual([])
    expect(server.plays.size).toBe(1)
  })

  it('a refusal (422/413) is shown and not retried', async () => {
    vi.useFakeTimers()
    const session = start()
    const play = gapPlays()[0]
    server.failNextWith(new ApiError('This play is too large to save.', 413))
    session.repository.savePlay(play)
    await settle()
    expect(session.stateOf(play.id)).toEqual({ state: 'failed', message: 'This play is too large to save.' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(server.calls).toHaveLength(1)
  })
})

describe('resolving a conflict - the coach decides', () => {
  async function conflicted() {
    const session = start()
    const play = gapPlays()[0]
    session.repository.savePlay(play)
    await settle()
    server.editElsewhere(100, 'Theirs')
    session.repository.savePlay(renamed(play, 'Mine'))
    await settle()
    return { session, play }
  }

  it('load the latest: the server version replaces the local one', async () => {
    const { session, play } = await conflicted()
    await session.resolveWithLatest(play.id)
    expect(session.stateOf(play.id).state).toBe('saved')
    expect(session.repository.listPlays().find((p) => p.id === play.id)!.name).toBe('Theirs')
    expect(draftKeys()).toEqual([])
    session.repository.savePlay(renamed(session.repository.listPlays()[0], 'Theirs, edited'))
    await settle()
    expect(server.plays.get(100)!.name).toBe('Theirs, edited')
  })

  it('keep mine: the coach\'s version becomes a new play and nothing is lost', async () => {
    const { session, play } = await conflicted()
    const copyId = await session.resolveKeepMine(play.id)
    await settle()
    expect(session.repository.currentPlayId()).toBe(copyId)
    const byName = Object.fromEntries([...server.plays.values()].map((row) => [row.name, row]))
    expect(Object.keys(byName).sort()).toEqual(['Mine (my version)', 'Theirs'])
    expect(session.repository.listPlays().find((p) => p.id === play.id)!.name).toBe('Theirs')
    expect(session.stateOf(copyId).state).toBe('saved')
  })

  it('while the editor remounts, its unmount flush cannot resurrect the discarded version', async () => {
    const { session, play } = await conflicted()
    session.beginDiscard([play.id])
    await session.resolveWithLatest(play.id)
    session.repository.savePlay(renamed(play, 'Mine (flushed on unmount)'))
    session.endDiscard()
    await settle()
    expect(session.repository.listPlays()[0].name).toBe('Theirs')
    expect(server.calls.filter((c) => c.kind === 'save')).toHaveLength(1)
  })
})

describe('drafts from an earlier page', () => {
  async function leaveWithUnsentEdit() {
    const first = start()
    const play = gapPlays()[0]
    first.repository.savePlay(play)
    await settle()
    server.failNextWith(new ApiError('offline', 0))
    first.repository.savePlay(renamed(play, 'Edited before the tab closed'))
    await settle()
    return play
  }

  it('are re-sent when nothing changed on the server since', async () => {
    vi.useFakeTimers()
    await leaveWithUnsentEdit()
    const second = start()
    expect(second.takeNotices()).toEqual(['Recovered unsaved changes to "Edited before the tab closed".'])
    await settle()
    expect(server.plays.get(100)!.name).toBe('Edited before the tab closed')
    expect(draftKeys()).toEqual([])
  })

  it('become a conflict when the server moved on meanwhile', async () => {
    vi.useFakeTimers()
    await leaveWithUnsentEdit()
    server.editElsewhere(100, 'Changed on another computer')
    const second = start()
    const id = second.clientIdOf(100)!
    expect(second.stateOf(id).state).toBe('conflict')
    expect(second.repository.listPlays()[0].name).toBe('Edited before the tab closed')
    expect(server.plays.get(100)!.name).toBe('Changed on another computer')
  })

  it('are simply cleared when the save did arrive after all', async () => {
    vi.useFakeTimers()
    const play = await leaveWithUnsentEdit()
    server.plays.get(100)!.name = 'Edited before the tab closed' // keepalive landed
    const second = start()
    expect(second.takeNotices()).toEqual([])
    expect(draftKeys()).toEqual([])
    await settle()
    expect(server.calls.filter((c) => c.kind === 'save')).toHaveLength(1)
    expect(play.id).toBeTruthy()
  })

  it('for a play deleted elsewhere come back as a new play, never dropped', async () => {
    vi.useFakeTimers()
    await leaveWithUnsentEdit()
    server.plays.delete(100)
    start()
    await settle()
    expect([...server.plays.values()].map((row) => row.name)).toEqual(['Edited before the tab closed (recovered)'])
  })

  it('belong to one organization and coach only', async () => {
    vi.useFakeTimers()
    await leaveWithUnsentEdit()
    const other = createMotionLabSession({ plays: server.playRows(), looks: [], draftScope: '9:9', api: server.api, drafts })
    expect(other.takeNotices()).toEqual([])
  })
})

describe('the library the editor sees', () => {
  it('deletes, including a play whose creation is still in flight', async () => {
    const session = start()
    const a = gapPlays()[0]
    session.repository.savePlay(a)
    await settle()
    session.repository.deletePlay(a.id)
    await settle()
    expect(server.plays.size).toBe(0)

    const b = gapPlays()[1]
    server.hold()
    session.repository.savePlay(b)
    await settle()
    session.repository.deletePlay(b.id)
    expect(session.repository.listPlays()).toEqual([])
    server.release()
    await settle(20)
    expect(server.plays.size).toBe(0)
    expect(draftKeys()).toEqual([])
  })

  it('refresh takes the server\'s version of untouched plays and keeps local work', async () => {
    const session = start()
    const [a, b] = gapPlays()
    session.repository.savePlay(a)
    session.repository.savePlay(b)
    await settle()
    server.editElsewhere(100, 'A renamed in the Library')
    server.failNextWith(new ApiError('offline', 0))
    session.repository.savePlay(renamed(session.repository.listPlays().find((p) => p.id === b.id)!, 'B unsaved'))
    await settle()
    session.refresh(server.playRows(), [])
    const names = session.repository.listPlays().map((p) => p.name).sort()
    expect(names).toEqual(['A renamed in the Library', 'B unsaved'])
  })

  it('saves and deletes looks', async () => {
    const session = start()
    const look = lookFromPlayers('Trips Rt', newPlay().players)
    session.repository.saveLook(look)
    expect(session.repository.listLooks().map((l) => l.name)).toEqual(['Trips Rt'])
    await settle()
    expect([...server.looks.values()].map((row) => row.name)).toEqual(['Trips Rt'])
    session.repository.deleteLook(look.id)
    await settle()
    expect(server.looks.size).toBe(0)
  })
})

describe('the version a save is written at', () => {
  // The version sent is the version of the SERIALIZER that wrote the bytes -
  // this client's `toDocument` - never whatever an in-memory object carries.
  // The editor built its play with `v: 1` long after the model moved to 2, and
  // the session trusted it: every play stored at v2 was refused, and a v1
  // play that gained roles or motion stayed v1, unprotected.
  const stale = (play: Play): Play => ({ ...play, v: 1 })

  it('a play is created and saved at this client\'s schema version, whatever it claims', async () => {
    const session = start()
    const play = gapPlays()[0]
    session.repository.savePlay(stale(play))
    await settle()
    session.repository.savePlay(stale(renamed(play, 'Toss Crack')))
    await settle()
    expect(server.calls.map((c) => [c.kind, (c.body as { schema_version: number }).schema_version])).toEqual([
      ['create', SCHEMA_VERSION],
      ['save', SCHEMA_VERSION],
    ])
    expect([...server.plays.values()][0].schema_version).toBe(SCHEMA_VERSION)
  })

  it('so does a look', async () => {
    const session = start()
    session.repository.saveLook({ ...lookFromPlayers('Trips Rt', newPlay().players), v: 1 })
    await settle()
    expect([...server.looks.values()].map((row) => row.schema_version)).toEqual([SCHEMA_VERSION])
  })
})

describe('a save refused because a newer Motion Lab wrote the play (P3.1 / P3.4)', () => {
  it('stops sending, says so, and never retries into the refusal', async () => {
    const session = start()
    const play = gapPlays()[0]
    session.repository.savePlay(play)
    await settle()

    // What the server answers a tab older than the stored document.
    server.failNextWith(new ApiError('This play was saved by a newer Motion Lab (v2); this tab writes v1. Reload before editing.', 409, undefined, 'schema_outdated'))
    session.repository.savePlay(renamed(play, 'Old tab edit'))
    await settle()

    // Honest: it stops and asks, exactly as for any 409 - no silent retry
    // loop, and nothing written over the newer play.
    expect(session.stateOf(play.id).state).toBe('conflict')
    const saves = server.calls.filter((c) => c.kind === 'save').length
    session.repository.savePlay(renamed(play, 'Old tab edit, again'))
    await settle()
    expect(server.calls.filter((c) => c.kind === 'save')).toHaveLength(saves)
  })
})

/**
 * THE SCRATCH PLAY (Motion Lab opens on the field): one per coach, kept on this
 * device, never sent until saveScratch - and then sent exactly once, as a new play.
 */
describe('the scratch play', () => {
  const edited = (play: Play): Play => ({ ...play, players: play.players.map((p, i) => (i === 0 ? { ...p, y: p.y - 1 } : p)), updatedAt: play.updatedAt + 1 })

  it('is never sent, however often it is saved, and says it is unsaved', async () => {
    const session = start()
    const { id, previous } = session.startScratch()
    expect(previous).toBeNull()
    const play = session.repository.listPlays().find((p) => p.id === id)!
    expect(play.name).toBe('New play')
    session.repository.savePlay(edited(play))
    session.repository.savePlay(renamed(edited(play), 'Still scratch'))
    await settle(10)
    expect(server.calls).toHaveLength(0)
    expect(session.stateOf(id).state).toBe('unsaved')
    expect(session.isScratch(id)).toBe(true)
    expect(session.scratchTouched()).toBe(true)
    expect(session.pendingCount()).toBe(0)
  })

  it('survives a new page in the same browser, and the Library can see it once it has work in it', async () => {
    const first = start()
    const { id } = first.startScratch()
    expect(peekScratch(SCOPE, drafts)).toBeNull()
    first.repository.savePlay(renamed(edited(first.repository.listPlays().find((p) => p.id === id)!), 'Idea'))
    const second = start()
    expect(second.scratchId()).toBe(id)
    expect(second.scratchTouched()).toBe(true)
    expect(second.repository.listPlays().find((p) => p.id === id)!.name).toBe('Idea')
    expect(peekScratch(SCOPE, drafts)).toMatchObject({ name: 'Idea' })
    await settle(10)
    expect(server.calls).toHaveLength(0)
  })

  it('a fresh one hands back the old one only when it had work in it', () => {
    const session = start()
    const first = session.startScratch()
    expect(session.startScratch().previous).toBeNull()
    const id = session.scratchId()!
    expect(id).not.toBe(first.id)
    session.repository.savePlay(edited(session.repository.listPlays().find((p) => p.id === id)!))
    const replaced = session.startScratch()
    expect(replaced.previous?.id).toBe(id)
    expect(session.repository.listPlays().filter((p) => session.isScratch(p.id))).toHaveLength(1)
    const back = session.restoreScratch(replaced.previous!)
    expect(back).toBe(id)
    expect(session.scratchId()).toBe(id)
  })

  it('saveScratch creates it once on the server, in its folder, and it autosaves like any play after', async () => {
    const session = start()
    const { id } = session.startScratch(undefined, undefined, 4)
    const play = edited(session.repository.listPlays().find((p) => p.id === id)!)
    session.saveScratch({ ...play, name: 'Jet Dig' })
    expect(session.scratchId()).toBeNull()
    expect(session.isScratch(id)).toBe(false)
    await settle(10)
    const creates = server.calls.filter((c) => c.kind === 'create')
    expect(creates).toHaveLength(1)
    expect(creates[0].body).toMatchObject({ name: 'Jet Dig', folder_id: 4, schema_version: SCHEMA_VERSION })
    expect(session.serverIdOf(id)).not.toBeNull()
    expect(session.stateOf(id).state).toBe('saved')
    expect(draftKeys().filter((k) => k.endsWith(':scratch'))).toHaveLength(0)
    session.repository.savePlay(renamed(play, 'Jet Dig 2'))
    await settle(10)
    expect(server.calls.filter((c) => c.kind === 'save')).toHaveLength(1)
    // A new page: no scratch any more, and the saved play is an ordinary play.
    expect(start().scratchId()).toBeNull()
  })
})
