import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { getErrorMessage } from '../api/client'
import { deleteFolder, renameFolder } from '../api/folders'
import {
  copyMotionPlay,
  createMotionFolder,
  createMotionPlay,
  deleteMotionLook,
  deleteMotionPlay,
  listMotionFolders,
  listMotionLooks,
  listMotionPlays,
  updateMotionPlay,
  type MotionLookRow,
  type MotionPlayRow,
} from '../api/motionLab'
import type { Folder } from '../api/types'
import { ErrorBanner } from '../components/ErrorBanner'
import { useConfirmDialog } from '../components/ConfirmDialog'
import { EmptyState } from '../components/ui/EmptyState'
import { Icon } from '../components/ui/Icon'
import { LoadingState } from '../components/ui/LoadingState'
import { MenuButton, MenuItem } from '../components/ui/MenuButton'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import nb from '../styles/notebook.module.css'
import dashboardStyles from '../pages/DashboardPage.module.css'
import folderStyles from '../pages/FolderPage.module.css'
import { newPlay, SCHEMA_VERSION } from './engine/play'
import { toDocument } from './storage/apiPlayRepository'
import styles from './MotionLabLibraryPage.module.css'

/**
 * THE MOTION LAB LIBRARY - the organization's plays, filed in Motion Lab
 * folders, plus its saved looks.
 *
 * Deliberately small. It uses PEIRA's existing folder idea and look (folders are
 * places to go, a breadcrumb for the path, one "..." menu per row) over the
 * Motion Lab folder tree, which is a separate tree from Quizzes. A play is
 * already reusable and a duplicate is already a starting point - there is no
 * template type, no Game Plan, and no content system here.
 *
 * Everything shown is the organization's: plays and folders are collaborative,
 * so there is no "mine" filter.
 */
export function MotionLabLibraryPage() {
  const { folderId: folderParam } = useParams<{ folderId: string }>()
  const folderId = folderParam ? Number(folderParam) : null
  const navigate = useNavigate()
  const { confirm, dialog } = useConfirmDialog()

  const [folders, setFolders] = useState<Folder[] | null>(null)
  const [plays, setPlays] = useState<MotionPlayRow[] | null>(null)
  const [looks, setLooks] = useState<MotionLookRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [renaming, setRenaming] = useState<{ kind: 'play' | 'folder'; id: number; value: string } | null>(null)
  const [moving, setMoving] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const [folderList, playList, lookList] = await Promise.all([listMotionFolders(), listMotionPlays(), listMotionLooks()])
      setFolders(folderList)
      setPlays(playList)
      setLooks(lookList)
    } catch (err) {
      setError(getErrorMessage(err))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const folder = folderId !== null ? (folders?.find((f) => f.id === folderId) ?? null) : null
  useDocumentTitle(folder ? `${folder.name} — Motion Lab` : 'Motion Lab — Peira')

  if (error && (!folders || !plays)) return <ErrorBanner message={error} />
  if (!folders || !plays || !looks) return <LoadingState />
  if (folderId !== null && !folder) {
    return <EmptyState message="This folder isn't in your Motion Lab. It may have been deleted." />
  }

  const ancestors: Folder[] = []
  for (let f = folder; f && f.parent_folder_id !== null; ) {
    const parent = folders.find((candidate) => candidate.id === f!.parent_folder_id)
    if (!parent) break
    ancestors.unshift(parent)
    f = parent
  }
  const subfolders = folders.filter((f) => f.parent_folder_id === folderId)
  const here = plays.filter((p) => p.folder_id === folderId)
  const inTree = (id: number): number => {
    const children = folders.filter((f) => f.parent_folder_id === id)
    return plays.filter((p) => p.folder_id === id).length + children.reduce((sum, child) => sum + inTree(child.id), 0)
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      await load()
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleNewPlay(fromPlayers?: MotionLookRow) {
    setBusy(true)
    setError(null)
    try {
      const play = fromPlayers
        ? newPlay(`${fromPlayers.name} — new play`, fromPlayers.document.players as ReturnType<typeof newPlay>['players'])
        : newPlay()
      const created = await createMotionPlay({
        name: play.name,
        document: toDocument(play),
        schema_version: SCHEMA_VERSION,
        folder_id: folderId,
      })
      navigate(`/motion-lab/plays/${created.id}`)
    } catch (err) {
      setError(getErrorMessage(err))
      setBusy(false)
    }
  }

  async function handleNewFolder(event: FormEvent) {
    event.preventDefault()
    const name = newFolderName.trim()
    if (!name) return
    await run(async () => {
      await createMotionFolder({ name, parent_folder_id: folderId })
      setNewFolderName('')
    })
  }

  async function commitRename() {
    if (!renaming) return
    const value = renaming.value.trim()
    if (!value) return
    const { kind, id } = renaming
    setRenaming(null)
    await run(() => (kind === 'play' ? updateMotionPlay(id, { name: value }) : renameFolder(id, { name: value })))
  }

  function renameInput() {
    return (
      <input
        autoFocus
        className={nb.input}
        value={renaming!.value}
        onChange={(e) => setRenaming({ ...renaming!, value: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitRename()
          if (e.key === 'Escape') setRenaming(null)
        }}
        aria-label="New name"
      />
    )
  }

  const folderPath = (f: Folder): string => {
    const names = [f.name]
    for (let p = f; p.parent_folder_id !== null; ) {
      const parent = folders.find((candidate) => candidate.id === p.parent_folder_id)
      if (!parent) break
      names.unshift(parent.name)
      p = parent
    }
    return names.join(' / ')
  }

  return (
    <div className={styles.page}>
      {dialog}
      <div className={folderStyles.header}>
        <nav className={folderStyles.breadcrumb} aria-label="Motion Lab folder path">
          {folder ? (
            <span className={folderStyles.crumbs}>
              <Link to="/motion-lab" className={folderStyles.crumb}>
                Motion Lab
              </Link>
              {ancestors.map((ancestor) => (
                <span key={ancestor.id}>
                  <span className={folderStyles.crumbSeparator}>/</span>
                  <Link to={`/motion-lab/folders/${ancestor.id}`} className={folderStyles.crumb}>
                    {ancestor.name}
                  </Link>
                </span>
              ))}
              <span className={folderStyles.crumbSeparator}>/</span>
              <span className={folderStyles.crumbCurrent}>{folder.name}</span>
            </span>
          ) : null}
        </nav>
      </div>

      <div className={dashboardStyles.contentHeader}>
        <h1 className={nb.heading}>{folder ? folder.name : 'Motion Lab'}</h1>
        <span className={nb.countBadge}>
          {folder ? inTree(folder.id) : plays.length} Play{(folder ? inTree(folder.id) : plays.length) === 1 ? '' : 's'}
        </span>
      </div>

      <div className={styles.actions}>
        <button className={nb.btnPrimary} disabled={busy} onClick={() => handleNewPlay()}>
          <Icon name="add" size={14} /> New play
        </button>
        <form className={styles.inlineForm} onSubmit={handleNewFolder}>
          <input
            className={nb.input}
            placeholder={folder ? 'New folder, e.g. Cover 3' : 'New folder, e.g. Defense'}
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            aria-label="New folder name"
          />
          <button type="submit" className={nb.btnSm} disabled={busy || !newFolderName.trim()}>
            New folder
          </button>
        </form>
      </div>

      <ErrorBanner message={error} />

      {subfolders.length > 0 && (
        <div className={dashboardStyles.folderList}>
          {subfolders.map((sub) => {
            const hasChildren = folders.some((f) => f.parent_folder_id === sub.id)
            return renaming?.kind === 'folder' && renaming.id === sub.id ? (
              <div key={sub.id} className={dashboardStyles.folderRow}>
                {renameInput()}
                <button className={nb.btnSm} onClick={commitRename} disabled={!renaming.value.trim()}>
                  Save
                </button>
                <button className={nb.btnSm} onClick={() => setRenaming(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div key={sub.id} className={dashboardStyles.folderRow}>
                <Link to={`/motion-lab/folders/${sub.id}`} className={dashboardStyles.folderLink}>
                  <span className={dashboardStyles.folderIcon} aria-hidden="true">
                    <Icon name="chevronRight" size={16} />
                  </span>
                  <span className={dashboardStyles.folderName}>{sub.name}</span>
                  <span className={dashboardStyles.folderCount}>{inTree(sub.id)}</span>
                </Link>
                <MenuButton label={`Folder options for ${sub.name}`}>
                  <MenuItem onSelect={() => setRenaming({ kind: 'folder', id: sub.id, value: sub.name })}>Rename</MenuItem>
                  <MenuItem
                    destructive
                    disabled={hasChildren}
                    onSelect={() =>
                      confirm({
                        title: 'Delete folder?',
                        // The plays go to the Library's top level, not to this
                        // folder: MotionPlay.folder_id is ON DELETE SET NULL.
                        body: `"${sub.name}" will be deleted. Its plays are not deleted - they move to the top of the Library.`,
                        confirmLabel: 'Delete Folder',
                        action: () => run(() => deleteFolder(sub.id)),
                      }).catch(() => undefined)
                    }
                  >
                    {hasChildren ? 'Delete (empty its folders first)' : 'Delete folder'}
                  </MenuItem>
                </MenuButton>
              </div>
            )
          })}
        </div>
      )}

      {here.length === 0 ? (
        // At the top level, plays filed in folders still count: "No plays yet"
        // under a "3 Plays" badge would contradict itself.
        folder ? (
          <EmptyState message="No plays in this folder yet." />
        ) : plays.length === 0 ? (
          <EmptyState message="No plays yet. Start one with New play." />
        ) : null
      ) : (
        <div className={dashboardStyles.folderList} aria-label="Plays">
          {here.map((play) => (
            <div key={play.id} className={dashboardStyles.folderRow}>
              {renaming?.kind === 'play' && renaming.id === play.id ? (
                <>
                  {renameInput()}
                  <button className={nb.btnSm} onClick={commitRename} disabled={!renaming.value.trim()}>
                    Save
                  </button>
                  <button className={nb.btnSm} onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                </>
              ) : moving === play.id ? (
                <>
                  <span className={styles.moveLabel}>Move "{play.name}" to</span>
                  <select
                    autoFocus
                    className={nb.input}
                    aria-label={`Move ${play.name} to folder`}
                    defaultValue={play.folder_id ?? ''}
                    onChange={(e) => {
                      const target = e.target.value === '' ? null : Number(e.target.value)
                      setMoving(null)
                      if (target !== play.folder_id) run(() => updateMotionPlay(play.id, { folder_id: target }))
                    }}
                  >
                    <option value="">Top of the Library</option>
                    {folders
                      .map((f) => ({ id: f.id, path: folderPath(f) }))
                      .sort((a, b) => a.path.localeCompare(b.path))
                      .map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.path}
                        </option>
                      ))}
                  </select>
                  <button className={nb.btnSm} onClick={() => setMoving(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <Link to={`/motion-lab/plays/${play.id}`} className={dashboardStyles.folderLink}>
                    <span className={dashboardStyles.folderIcon} aria-hidden="true">
                      <Icon name="pen" size={14} />
                    </span>
                    <span className={dashboardStyles.folderName}>{play.name}</span>
                    <span className={styles.updated}>{new Date(play.updated_at).toLocaleDateString()}</span>
                  </Link>
                  <MenuButton label={`Play options for ${play.name}`}>
                    <MenuItem onSelect={() => setRenaming({ kind: 'play', id: play.id, value: play.name })}>Rename</MenuItem>
                    <MenuItem onSelect={() => run(() => copyMotionPlay(play.id))}>Duplicate</MenuItem>
                    <MenuItem onSelect={() => setMoving(play.id)}>Move to folder…</MenuItem>
                    <MenuItem
                      destructive
                      onSelect={() =>
                        confirm({
                          title: 'Delete play?',
                          body: `"${play.name}" will be permanently deleted for everyone in your organization. Copies made from it are not affected.`,
                          confirmLabel: 'Delete Play',
                          action: () => run(() => deleteMotionPlay(play.id)),
                        }).catch(() => undefined)
                      }
                    >
                      Delete play
                    </MenuItem>
                  </MenuButton>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {folder === null && (
        <section className={styles.looks} aria-labelledby="motion-lab-looks">
          <h2 id="motion-lab-looks" className={nb.headingSm}>
            Looks
          </h2>
          {looks.length === 0 ? (
            <p className={styles.hint}>Save a look from a play&apos;s Look menu to start plays from the same alignment.</p>
          ) : (
            <div className={dashboardStyles.folderList} aria-label="Saved looks">
              {looks.map((look) => (
                <div key={look.id} className={dashboardStyles.folderRow}>
                  <span className={styles.lookName}>{look.name}</span>
                  <button
                    className={nb.btnSm}
                    disabled={busy}
                    onClick={() => handleNewPlay(look)}
                    aria-label={`New play from ${look.name}`}
                  >
                    New play
                  </button>
                  <MenuButton label={`Look options for ${look.name}`}>
                    <MenuItem
                      destructive
                      onSelect={() =>
                        confirm({
                          title: 'Delete look?',
                          body: `"${look.name}" will be deleted. Plays started from it are not affected.`,
                          confirmLabel: 'Delete Look',
                          action: () => run(() => deleteMotionLook(look.id)),
                        }).catch(() => undefined)
                      }
                    >
                      Delete look
                    </MenuItem>
                  </MenuButton>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
