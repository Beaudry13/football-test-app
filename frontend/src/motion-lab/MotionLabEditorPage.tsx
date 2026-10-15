import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { getErrorMessage } from '../api/client'
import { listMotionLooks, listMotionPlays } from '../api/motionLab'
import { useAuth } from '../auth/AuthContext'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { MotionLabEditor } from './authoring/MotionLabEditor'
import type { Player } from './engine/formation'
import type { Play } from './engine/play'
import { getMotionLabSession, type MotionLabSession, type PlaySaveState } from './storage/apiPlayRepository'
import { VIEWER_3D_URL, viewIn3D } from './viewIn3D'
import './motionLab.css'

/**
 * ONE MOTION LAB PLAY, open in the validated editor, saved to PEIRA.
 *
 * Full screen like annotation (outside NotebookLayout). The organization's
 * plays and looks are loaded into the coach's Motion Lab session
 * (storage/apiPlayRepository.ts), the play in the URL is made current, and the
 * editor mounts on top of it. The editor's own play menu still switches plays;
 * the URL follows it.
 *
 * WHAT THIS PAGE ADDS OVER THE EDITOR: the real save state (the editor's
 * built-in "Saved" could only mean "accepted locally"), and the one decision
 * the coach must make when a play was changed or deleted somewhere else.
 * Resolving remounts the editor on the chosen version.
 *
 * MOTION LAB OPENS ON THE FIELD. At /motion-lab (no play id) the coach lands
 * straight in the editor, on his SCRATCH play - kept on this device, never
 * written to PEIRA (apiPlayRepository: the scratch play) - so opening Motion Lab
 * creates nothing. "Save play" saves it as an ordinary play and the URL moves to
 * it. "+ New play" starts a fresh scratch play; if the old one had work in it,
 * Undo puts it back for a few seconds. Opening a saved play leaves the scratch
 * play where it is: /motion-lab (or "Continue" in the Library) brings it back.
 */
export default function MotionLabEditorPage() {
  const { playId } = useParams<{ playId: string }>()
  const { coach } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  /** At /motion-lab: the coach's scratch play, not a saved one. */
  const scratchRoute = playId === undefined
  /** The Library's "New play" (optionally from a saved formation). */
  const fresh = (location.state as { fresh?: boolean; players?: Player[]; name?: string; folderId?: number | null } | null) ?? null
  /** A replaced scratch play the coach can still get back. */
  const [undoScratch, setUndoScratch] = useState<Play | null>(null)
  const [session, setSession] = useState<MotionLabSession | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notices, setNotices] = useState<string[]>([])
  const [editorKey, setEditorKey] = useState(0)
  const [resolving, setResolving] = useState(false)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  /** The editor's own "an edit is on screen and not yet handed over" (see saveStatus). */
  const editPending = useRef(false)
  /** The server id the URL was last set to - so the page can tell the editor
   *  switching plays (follow it) from the coach navigating (load it). null: the
   *  URL is /motion-lab, the scratch play. */
  const urlPlayId = useRef<number | null | undefined>(undefined)

  const scope = coach ? `${coach.organization_id}:${coach.id}` : ''

  useEffect(() => {
    const requested = scratchRoute ? null : Number(playId)
    if (session && requested === urlPlayId.current && !fresh?.fresh) return
    let cancelled = false
    setNotFound(false)
    Promise.all([listMotionPlays(), listMotionLooks()])
      .then(([plays, looks]) => {
        if (cancelled) return
        const loaded = getMotionLabSession(scope, plays, looks)
        let clientId: string | null
        if (requested === null) {
          // The field, at once: his scratch play, or a fresh one.
          clientId = loaded.scratchId()
          if (fresh?.fresh || !clientId) {
            const started = loaded.startScratch(fresh?.players, fresh?.name, fresh?.folderId ?? null)
            clientId = started.id
            setUndoScratch(started.previous)
          }
          // A refresh must not start yet another play.
          if (fresh) navigate(location.pathname, { replace: true, state: null })
        } else {
          clientId = loaded.clientIdOf(requested)
        }
        if (!clientId) {
          setNotFound(true)
          return
        }
        loaded.repository.setCurrentPlayId(clientId)
        urlPlayId.current = requested
        setNotices((current) => [...current, ...loaded.takeNotices()])
        setSession(loaded)
        setEditorKey((key) => key + 1)
      })
      .catch((err) => {
        if (!cancelled) setError(getErrorMessage(err))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playId, scope, location.key])

  // Follow the session: re-render on save-state changes, keep the URL on the
  // current play once it has a server id, and surface notices.
  useEffect(() => {
    if (!session) return
    return session.subscribe(() => {
      rerender()
      const current = session.repository.currentPlayId()
      const serverId = current ? session.serverIdOf(current) : null
      if (serverId !== null && serverId !== urlPlayId.current) {
        urlPlayId.current = serverId
        navigate(`/motion-lab/plays/${serverId}`, { replace: true })
      } else if (current && session.isScratch(current) && urlPlayId.current !== null) {
        urlPlayId.current = null
        navigate('/motion-lab', { replace: true })
      }
      const fresh = session.takeNotices()
      if (fresh.length) setNotices((current) => [...current, ...fresh])
    })
  }, [session, navigate])

  // After a resolution remounts the editor, saves to the resolved play count
  // again. Runs after the old editor's unmount flush and the new one's load.
  useEffect(() => {
    session?.endDiscard()
  }, [session, editorKey])

  // Undo for a replaced scratch play is offered for a few seconds, then it is gone.
  useEffect(() => {
    if (!undoScratch) return
    const id = setTimeout(() => setUndoScratch(null), UNDO_MS)
    return () => clearTimeout(id)
  }, [undoScratch])

  const current = session?.repository.currentPlayId() ?? null
  const status = current && session ? session.stateOf(current) : null
  const currentName = current ? session?.repository.listPlays().find((p) => p.id === current)?.name : undefined
  useDocumentTitle(currentName ? `${currentName} — Motion Lab` : 'Motion Lab — Peira')

  const loadLatest = useCallback(async () => {
    if (!session || !current) return
    setResolving(true)
    session.beginDiscard([current])
    try {
      const deleted = session.stateOf(current).state === 'deleted-elsewhere'
      await session.resolveWithLatest(current)
      if (deleted) {
        session.endDiscard()
        navigate('/motion-lab/library')
        return
      }
      setEditorKey((key) => key + 1)
    } catch (err) {
      session.endDiscard()
      setError(getErrorMessage(err))
    } finally {
      setResolving(false)
    }
  }, [session, current, navigate])

  const keepMine = useCallback(async () => {
    if (!session || !current) return
    setResolving(true)
    session.beginDiscard([current])
    try {
      await session.resolveKeepMine(current)
      setEditorKey((key) => key + 1)
    } catch (err) {
      session.endDiscard()
      setError(getErrorMessage(err))
    } finally {
      setResolving(false)
    }
  }, [session, current])

  if (notFound) {
    return (
      <div className="motion-lab-root">
        <div className="ml-notice" role="alert">
          <span>
            <b>This play isn't in your Motion Lab.</b> It may have been deleted.
          </span>
          <button onClick={() => navigate('/motion-lab/library')}>Open the Library</button>
        </div>
      </div>
    )
  }
  if (error && !session) {
    return (
      <div className="motion-lab-root">
        <div className="ml-notice" role="alert">
          <span>
            <b>Motion Lab could not load.</b> {error}
          </span>
          <button onClick={() => window.location.reload()}>Try again</button>
        </div>
      </div>
    )
  }
  if (!session) return <div className="motion-lab-root" aria-busy="true" />

  const folderId = current ? session.folderIdOf(current) : null

  /**
   * V6, development only: open the saved play in the 3D viewer. Offered when
   * VITE_MOTION_LAB_3D_URL is set; hands over only a play whose last edit the
   * server has confirmed, because the viewer is shown the SAVED play.
   */
  const open3D = () => {
    const id = session.repository.currentPlayId()
    if (id && session.isScratch(id)) {
      setNotices((all) => [...all, 'Save the play first - View in 3D shows the saved play.'])
      return
    }
    const serverId = id ? session.serverIdOf(id) : null
    const saved = id !== null && session.stateOf(id).state === 'saved' && !editPending.current
    if (!VIEWER_3D_URL || serverId === null || !saved) {
      setNotices((all) => [...all, 'Saving… View in 3D shows the saved play - try again in a moment.'])
      return
    }
    if (!viewIn3D(VIEWER_3D_URL, serverId)) setNotices((all) => [...all, 'The 3D viewer window was blocked - allow pop-ups for this site.'])
  }

  /** "+ New play": a fresh scratch play from these men. Undo brings the old one back. */
  const startNewPlay = (players: Player[], name?: string) => {
    const started = session.startScratch(players, name)
    session.repository.setCurrentPlayId(started.id)
    setUndoScratch(started.previous)
    urlPlayId.current = null
    if (!scratchRoute) navigate('/motion-lab')
    setEditorKey((key) => key + 1)
  }
  const undoNewPlay = () => {
    if (!undoScratch) return
    const id = session.restoreScratch(undoScratch)
    session.repository.setCurrentPlayId(id)
    setUndoScratch(null)
    urlPlayId.current = null
    if (!scratchRoute) navigate('/motion-lab')
    setEditorKey((key) => key + 1)
  }
  const onScratch = current !== null && session.isScratch(current)

  let notice = null
  if (status?.state === 'conflict') {
    notice = (
      <div className="ml-notice" role="alert">
        <span>
          <b>This play was changed somewhere else.</b> Your latest changes are still here but are not saved.
        </span>
        <button disabled={resolving} onClick={keepMine}>
          Keep mine as a copy
        </button>
        <button disabled={resolving} onClick={loadLatest}>
          Load the latest version
        </button>
      </div>
    )
  } else if (status?.state === 'deleted-elsewhere') {
    notice = (
      <div className="ml-notice" role="alert">
        <span>
          <b>This play was deleted somewhere else.</b> Your version is still here but is not saved.
        </span>
        <button disabled={resolving} onClick={keepMine}>
          Keep mine as a new play
        </button>
        <button disabled={resolving} onClick={loadLatest}>
          Close it
        </button>
      </div>
    )
  } else if (undoScratch) {
    notice = (
      <div className="ml-notice" role="status">
        <span>
          <b>New play started.</b> The unsaved play you had was cleared.
        </span>
        <button onClick={undoNewPlay}>Undo</button>
        <button onClick={() => setUndoScratch(null)}>OK</button>
      </div>
    )
  } else if (error || notices.length > 0) {
    notice = (
      <div className="ml-notice" role="status">
        <span>{error ?? notices[0]}</span>
        <button
          onClick={() => {
            if (error) setError(null)
            else setNotices((all) => all.slice(1))
          }}
        >
          OK
        </button>
      </div>
    )
  }

  return (
    <div className="motion-lab-root">
      <MotionLabEditor
        key={editorKey}
        repository={session.repository}
        exit={
          <>
            <button onClick={() => navigate(folderId !== null ? `/motion-lab/folders/${folderId}` : '/motion-lab/library')} title="Your saved plays">
              Library
            </button>
            {VIEWER_3D_URL && !onScratch && (
              <button onClick={open3D} title="Open the saved play in the PEIRA 3D viewer (development)">
                View in 3D
              </button>
            )}
          </>
        }
        saveStatus={({ editPending: pending }) => {
          editPending.current = pending
          // Read the session HERE, not from this render: the editor calls
          // this in its own renders too - on every edit, and at the handoff,
          // where savePlay may change nothing the page would re-render for.
          const id = session.repository.currentPlayId()
          const live = id ? session.stateOf(id) : null
          return <SaveStatus state={shownSaveState(live?.state ?? 'saved', pending)} message={live?.message ?? null} />
        }}
        notice={notice}
        isUnsaved={(id) => session.isScratch(id)}
        onSaveUnsaved={(play) => session.saveScratch(play)}
        onNewPlay={startNewPlay}
      />
    </div>
  )
}

/**
 * WHAT THE COACH IS TOLD (ML-UX-6, SPEC §3.3: "Saving…" from the first edit
 * until the write succeeds).
 *
 * The session knows about the write. Only the editor knows about the 400 ms
 * before it, when an edit is on screen and not yet handed over - and until
 * this, that window read "Saved". So an edit the editor is still holding turns
 * "Saved" into "Saving…".
 *
 * IT NEVER OUTRANKS A PROBLEM, and never says "Saved" on its own. After a
 * failure the session does not send on the next edit: a retry is already
 * scheduled (`retrying`), the refusal is permanent until the coach resolves it
 * (`failed`), or a conflict is waiting for a decision. "Saving…" there would
 * announce an attempt that is not happening - so the session's word stands.
 * The editor's own fallback indicator differs on purpose: a local write really
 * is retried at the next edit's flush.
 */
/** How long a replaced scratch play can be brought back. */
const UNDO_MS = 10000

function shownSaveState(session: PlaySaveState, editPending: boolean): PlaySaveState {
  return editPending && session === 'saved' ? 'saving' : session
}

function SaveStatus({ state, message }: { state: string; message: string | null }) {
  const text: Record<string, string> = {
    saved: 'Saved',
    unsaved: 'Not saved',
    saving: 'Saving…',
    retrying: 'Not saved — retrying',
    failed: 'Not saved',
    conflict: 'Not saved',
    'deleted-elsewhere': 'Not saved',
  }
  const bad = state !== 'saved' && state !== 'saving'
  return (
    <span className={`saved${bad ? ' failed' : ''}`} role="status" title={message ?? undefined}>
      {text[state]}
    </span>
  )
}
