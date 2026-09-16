import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { getErrorMessage } from '../api/client'
import { listMotionLooks, listMotionPlays } from '../api/motionLab'
import { useAuth } from '../auth/AuthContext'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { MotionLabEditor } from './authoring/MotionLabEditor'
import { getMotionLabSession, type MotionLabSession } from './storage/apiPlayRepository'
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
 */
export default function MotionLabEditorPage() {
  const { playId } = useParams<{ playId: string }>()
  const { coach } = useAuth()
  const navigate = useNavigate()
  const [session, setSession] = useState<MotionLabSession | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notices, setNotices] = useState<string[]>([])
  const [editorKey, setEditorKey] = useState(0)
  const [resolving, setResolving] = useState(false)
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  /** The server id the URL was last set to - so the page can tell the editor
   *  switching plays (follow it) from the coach navigating (load it). */
  const urlPlayId = useRef<number | null>(null)

  const scope = coach ? `${coach.organization_id}:${coach.id}` : ''

  useEffect(() => {
    const requested = Number(playId)
    if (session && requested === urlPlayId.current) return
    let cancelled = false
    setNotFound(false)
    Promise.all([listMotionPlays(), listMotionLooks()])
      .then(([plays, looks]) => {
        if (cancelled) return
        const loaded = getMotionLabSession(scope, plays, looks)
        const clientId = loaded.clientIdOf(requested)
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
  }, [playId, scope])

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
        navigate('/motion-lab')
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
          <button onClick={() => navigate('/motion-lab')}>Open the Library</button>
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
          <button onClick={() => navigate(folderId !== null ? `/motion-lab/folders/${folderId}` : '/motion-lab')} title="Back to the Motion Lab Library">
            ← Library
          </button>
        }
        saveStatus={<SaveStatus state={status?.state ?? 'saved'} message={status?.message ?? null} />}
        notice={notice}
      />
    </div>
  )
}

function SaveStatus({ state, message }: { state: string; message: string | null }) {
  const text: Record<string, string> = {
    saved: 'Saved',
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
