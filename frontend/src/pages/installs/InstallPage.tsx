import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getErrorMessage } from '../../api/client';
import {
  addToInstall,
  deleteInstall,
  duplicateInstall,
  getInstall,
  itemsInOrder,
  keepStatus,
  layoutOf,
  removeFromInstall,
  setInstallLayout,
  updateInstall,
  type Install,
  type InstallItem,
  type InstallItemKind,
  type InstallLayout,
} from '../../api/installs';
import { getGroupNeeds, listPlayers, type GroupNeeds } from '../../api/players';
import type { Player } from '../../api/types';
import { useConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { MenuButton, MenuItem } from '../../components/ui/MenuButton';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useMayUseMotionLab } from '../../motion-lab/motionLabAccess';
import nb from '../../styles/notebook.module.css';
import { audiencesFrom } from '../reps/audiences';
import { AddFootball } from './AddFootball';
import { InstallMeeting } from './InstallMeeting';
import { contents, itemDetail, itemHref, kindLabel } from './installDetail';
import styles from './Installs.module.css';
import { fromHere, useGoFromHere } from '../../navigation/backTo';

/**
 * AN INSTALL: "Week 7 - Central" - the football he is installing this
 * week, in the order he will teach it, with what PEIRA already knows about
 * each piece beside it.
 *
 * One primary action: Teach install - the meeting, item to item, on the Teach
 * screen. Add football finds what he already has. Each row has one action
 * (Teach this) and everything else one tap down (open it, its results, move
 * it to a section, take it out); ↑ ↓ put it in order, on a phone too. One
 * level of sections, if he wants them. Nothing here copies football: an item
 * is a reference, and taking it out leaves the football where it was.
 */
export function InstallPage() {
  const { installId } = useParams<{ installId: string }>();
  const id = Number(installId);
  const navigate = useNavigate();
  const location = useLocation();
  const go = useGoFromHere();
  const [params, setParams] = useSearchParams();
  const motionLab = useMayUseMotionLab();
  const { confirm, dialog } = useConfirmDialog();
  const [install, setInstall] = useState<Install | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [teachingAt, setTeachingAt] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const [newSection, setNewSection] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  /** The copy becomes the current install - offered, ticked when the source is current. */
  const [copyCurrent, setCopyCurrent] = useState(false);
  /** "Who it's for" is open - a rare change, so it waits behind More. */
  const [choosingGroup, setChoosingGroup] = useState(false);
  const [players, setPlayers] = useState<Player[]>([]);
  const [needs, setNeeds] = useState<GroupNeeds | null>(null);
  useDocumentTitle(install ? install.title : 'Install');

  useEffect(() => {
    getInstall(id)
      .then((loaded) => {
        setInstall(loaded);
        setTitle(loaded.title);
      })
      .catch((err) => setError(getErrorMessage(err)));
    listPlayers({ active: 'true' })
      .then(setPlayers)
      .catch(() => setPlayers([]));
  }, [id]);

  /* THE ROOM IT IS FOR: a position group (the roster's families) - so a
     concept can say how many of that room still miss it, and the meeting can
     retest exactly them. */
  const audiences = useMemo(() => audiencesFrom(players), [players]);
  const group = install?.position_group ? (audiences.find((a) => a.key === install.position_group) ?? null) : null;
  const groupPlural = group ? (group.family?.plural ?? group.name) : 'players';
  const needsPromise = useRef<Promise<GroupNeeds | null> | null>(null);
  const groupNeeds = () => {
    if (!group) return Promise.resolve(null);
    if (!needsPromise.current) needsPromise.current = getGroupNeeds(group.playerIds).catch(() => null);
    return needsPromise.current;
  };
  const groupKey = group ? group.playerIds.join(',') : '';
  useEffect(() => {
    needsPromise.current = null;
    setNeeds(null);
    if (!groupKey) return;
    let live = true;
    void groupNeeds().then((n) => live && setNeeds(n));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey]);

  // Home's "Teach" arrives with ?teach=1: the meeting opens at the first item.
  useEffect(() => {
    if (install && params.get('teach') && install.items.length > 0) {
      setTeachingAt(Number(params.get('at')) || 0);
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [install]);

  if (error && !install) {
    return (
      <div>
        <Link to="/installs" className={styles.back}>
          ← Installs
        </Link>
        <ErrorBanner message={error} />
      </div>
    );
  }
  if (!install) return <LoadingState label="Opening the install" />;

  const order = itemsInOrder(install).filter((i) => motionLab || i.kind !== 'play');
  const layout = layoutOf(install);

  /** The order changes here at once; the server's answer replaces it. */
  const saveLayout = async (next: InstallLayout) => {
    setError(null);
    const byId = new Map(install.items.map((i) => [i.id, i]));
    const sections = next.sections.map((s, position) => ({ id: s.id ?? -1 - position, title: s.title, position }));
    const items = [
      ...next.loose.map((iid, position) => ({ ...byId.get(iid)!, section_id: null, position })),
      ...next.sections.flatMap((s, si) => s.item_ids.map((iid, position) => ({ ...byId.get(iid)!, section_id: sections[si].id, position }))),
    ] as InstallItem[];
    setInstall({ ...install, sections, items });
    try {
      setInstall(keepStatus(await setInstallLayout(install.id, next), install));
    } catch (err) {
      setError(getErrorMessage(err));
      getInstall(install.id).then(setInstall, () => undefined);
    }
  };

  const listOf = (l: InstallLayout, itemId: number) =>
    l.loose.includes(itemId) ? l.loose : (l.sections.find((s) => s.item_ids.includes(itemId))?.item_ids ?? null);
  const move = (itemId: number, by: -1 | 1) => {
    const next: InstallLayout = { loose: [...layout.loose], sections: layout.sections.map((s) => ({ ...s, item_ids: [...s.item_ids] })) };
    const list = listOf(next, itemId)!;
    const at = list.indexOf(itemId);
    const to = at + by;
    if (to < 0 || to >= list.length) return;
    [list[at], list[to]] = [list[to], list[at]];
    void saveLayout(next);
  };
  const moveTo = (itemId: number, sectionId: number | null) => {
    const next: InstallLayout = {
      loose: layout.loose.filter((i) => i !== itemId),
      sections: layout.sections.map((s) => ({ ...s, item_ids: s.item_ids.filter((i) => i !== itemId) })),
    };
    if (sectionId === null) next.loose.push(itemId);
    else next.sections.find((s) => s.id === sectionId)!.item_ids.push(itemId);
    void saveLayout(next);
  };
  const moveSection = (sectionId: number, by: -1 | 1) => {
    const sections = [...layout.sections];
    const at = sections.findIndex((s) => s.id === sectionId);
    const to = at + by;
    if (to < 0 || to >= sections.length) return;
    [sections[at], sections[to]] = [sections[to], sections[at]];
    void saveLayout({ ...layout, sections });
  };
  const removeSection = (sectionId: number) => {
    const gone = layout.sections.find((s) => s.id === sectionId)!;
    // Its football stays in the install, before the sections.
    void saveLayout({ loose: [...layout.loose, ...gone.item_ids], sections: layout.sections.filter((s) => s.id !== sectionId) });
  };
  const renameSection = (sectionId: number, sectionTitle: string) =>
    void saveLayout({ ...layout, sections: layout.sections.map((s) => (s.id === sectionId ? { ...s, title: sectionTitle } : s)) });

  const add = async (kind: InstallItemKind, refId: number) => {
    setError(null);
    try {
      setInstall(await addToInstall(install.id, kind, refId));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };
  const remove = async (itemId: number) => {
    setError(null);
    try {
      setInstall(keepStatus(await removeFromInstall(install.id, itemId), install));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      setInstall(keepStatus(await updateInstall(install.id, { title: title.trim() }), install));
      setRenaming(false);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };
  const setGroup = async (key: string) => {
    try {
      setInstall(keepStatus(await updateInstall(install.id, { position_group: key || null }), install));
      setChoosingGroup(false);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };
  const archive = async (archived: boolean) => {
    try {
      setInstall(keepStatus(await updateInstall(install.id, { archived }), install));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };
  const makeCurrent = async () => {
    try {
      setInstall(keepStatus(await updateInstall(install.id, { current: true }), install));
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };
  const duplicate = async (e: FormEvent) => {
    e.preventDefault();
    if (!duplicating?.trim()) return;
    try {
      const copy = await duplicateInstall(install.id, duplicating.trim(), copyCurrent);
      setDuplicating(null);
      navigate(`/installs/${copy.id}`);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  };
  const remove_ = () =>
    void confirm({
      title: 'Delete this install?',
      body: `"${install.title}" - its order and sections - goes. Every play, quiz, Rep and concept in it stays exactly where it is.`,
      confirmLabel: 'Delete install',
      action: async () => {
        await deleteInstall(install.id);
        navigate('/installs');
      },
    });

  const row = (item: InstallItem, list: number[]) => {
    const at = list.indexOf(item.id);
    const detail = itemDetail(item, group ? { need: needs?.concepts.find((c) => c.concept_id === item.ref_id) ?? null, players: needs?.players ?? group.playerIds.length, plural: groupPlural } : null);
    const teachIndex = order.findIndex((o) => o.id === item.id);
    const title = item.kind === 'quiz' ? item.ref.title : item.ref.name;
    return (
      <li key={item.id} className={styles.item}>
        <span className={styles.tag} data-kind={kindLabel(item).toLowerCase()}>
          {kindLabel(item)}
        </span>
        <div className={styles.itemMain}>
          <Link to={itemHref(item)} state={fromHere(location, install.title)} className={styles.itemTitle}>
            {title}
          </Link>
          <span className={styles.itemDetail}>
            {detail.parts.join(' · ')}
            {detail.attention && <span className={styles.attention}> · {detail.attention}</span>}
          </span>
        </div>
        <div className={styles.itemActions}>
          {teachIndex >= 0 && (
            <button type="button" className={styles.teachButton} onClick={() => setTeachingAt(teachIndex)}>
              Teach
            </button>
          )}
          <button type="button" className={styles.arrow} aria-label={`Move ${title} up`} disabled={at <= 0} onClick={() => move(item.id, -1)}>
            ↑
          </button>
          <button type="button" className={styles.arrow} aria-label={`Move ${title} down`} disabled={at >= list.length - 1} onClick={() => move(item.id, 1)}>
            ↓
          </button>
          <MenuButton label={`More for ${title}`}>
            <MenuItem onSelect={() => go(itemHref(item))}>
              {item.kind === 'play' ? 'Open the play' : item.kind === 'concept' ? 'Open the concept' : item.ref.kind === 'REP' ? 'Open the Rep' : 'Open the quiz'}
            </MenuItem>
            {item.kind === 'quiz' && item.ref.kind !== 'REP' && (
              <MenuItem onSelect={() => go(`/quizzes/${item.ref_id}?tab=results`)}>Results</MenuItem>
            )}
            {item.section_id !== null && <MenuItem onSelect={() => moveTo(item.id, null)}>Move out of the section</MenuItem>}
            {install.sections
              .filter((s) => s.id !== item.section_id)
              .map((s) => (
                <MenuItem key={s.id} onSelect={() => moveTo(item.id, s.id)}>
                  Move to {s.title}
                </MenuItem>
              ))}
            <MenuItem destructive onSelect={() => void remove(item.id)}>
              Take out of the install
            </MenuItem>
          </MenuButton>
        </div>
      </li>
    );
  };

  return (
    <div className={styles.page}>
      {dialog}
      <Link to="/installs" className={styles.back}>
        ← Installs
      </Link>
      <header className={styles.head}>
        <div className={styles.headMain}>
          <span className={styles.kicker}>{install.archived ? 'Install · archived' : install.current ? 'Current install' : 'Install'}</span>
          {renaming ? (
            <form className={styles.renameForm} onSubmit={(e) => void rename(e)}>
              <input className={nb.input} value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Install name" maxLength={120} autoFocus />
              <button type="submit" className={nb.btnPrimary}>
                Save
              </button>
              <button type="button" className={nb.btnSecondary} onClick={() => setRenaming(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <h1 className={nb.heading}>{install.title}</h1>
          )}
          <span className={styles.meta}>
            {contents(install)}
            {group && <span className={styles.groupChip}>For {group.name}</span>}
          </span>
        </div>
        <div className={styles.headActions}>
          {/* Empty, the empty state below is the one way forward (Add football);
              a disabled gold Teach beside it would be a second, dead, gold. */}
          {order.length > 0 && (
            <button type="button" className={nb.btnPrimary} onClick={() => setTeachingAt(0)}>
              Teach install
            </button>
          )}
          {install.items.length > 0 && (
            <button type="button" className={nb.btnSecondary} aria-expanded={adding} onClick={() => setAdding((a) => !a)}>
              Add football
            </button>
          )}
          <MenuButton label={`More for ${install.title}`}>
            <MenuItem onSelect={() => setRenaming(true)}>Rename</MenuItem>
            <MenuItem onSelect={() => setNewSection('')}>Add a section</MenuItem>
            {audiences.length > 0 && <MenuItem onSelect={() => setChoosingGroup(true)}>Who it&rsquo;s for…</MenuItem>}
            {!install.current && !install.archived && <MenuItem onSelect={() => void makeCurrent()}>Set as current install</MenuItem>}
            <MenuItem
              onSelect={() => {
                setDuplicating(`${install.title} (copy)`);
                setCopyCurrent(install.current);
              }}
            >
              Duplicate for a new week
            </MenuItem>
            <MenuItem onSelect={() => void archive(!install.archived)}>{install.archived ? 'Restore' : 'Archive'}</MenuItem>
            <MenuItem destructive onSelect={remove_}>
              Delete install
            </MenuItem>
          </MenuButton>
        </div>
      </header>

      <ErrorBanner message={error} />

      {choosingGroup && audiences.length > 0 && (
        <label className={styles.groupPick}>
          <span>For</span>
          <select
            className={nb.input}
            value={install.position_group ?? ''}
            onChange={(e) => void setGroup(e.target.value)}
            onBlur={() => setChoosingGroup(false)}
            aria-label="Who this install is for"
            autoFocus
          >
            <option value="">The whole team</option>
            {audiences.map((a) => (
              <option key={a.key} value={a.key}>
                {a.name} · {a.playerIds.length}
              </option>
            ))}
          </select>
        </label>
      )}

      {duplicating !== null && (
        <form className={styles.inlineForm} onSubmit={(e) => void duplicate(e)}>
          <span>Same football, same order - a new name:</span>
          <input className={nb.input} value={duplicating} onChange={(e) => setDuplicating(e.target.value)} aria-label="New install name" maxLength={120} autoFocus />
          <label className={styles.check}>
            <input type="checkbox" checked={copyCurrent} onChange={(e) => setCopyCurrent(e.target.checked)} />
            Make it my current install
          </label>
          <button type="submit" className={nb.btnPrimary}>
            Duplicate
          </button>
          <button type="button" className={nb.btnSecondary} onClick={() => setDuplicating(null)}>
            Cancel
          </button>
        </form>
      )}

      {adding && <AddFootball install={install} motionLab={motionLab} onAdd={add} onClose={() => setAdding(false)} />}

      {install.items.length === 0 && !adding ? (
        <div className={styles.empty}>
          <p>Add the football you are installing - plays, Reps, quizzes, concepts. It stays where it is; the install just puts it in order.</p>
          <button type="button" className={nb.btnPrimary} onClick={() => setAdding(true)}>
            Add football
          </button>
        </div>
      ) : (
        <>
          {layout.loose.length > 0 && (
            <ol className={styles.items}>{layout.loose.map((iid) => row(install.items.find((i) => i.id === iid)!, layout.loose))}</ol>
          )}
          {layout.sections.map((s, si) => (
            <section key={s.id ?? si} className={styles.section} aria-label={s.title}>
              <div className={styles.sectionHead}>
                <h2 className={styles.sectionTitle}>{s.title}</h2>
                <MenuButton label={`More for ${s.title}`}>
                  <MenuItem
                    onSelect={() => {
                      const next = window.prompt('Section name', s.title);
                      if (next && next.trim()) renameSection(s.id!, next.trim());
                    }}
                  >
                    Rename
                  </MenuItem>
                  {si > 0 && <MenuItem onSelect={() => moveSection(s.id!, -1)}>Move up</MenuItem>}
                  {si < layout.sections.length - 1 && <MenuItem onSelect={() => moveSection(s.id!, 1)}>Move down</MenuItem>}
                  <MenuItem destructive onSelect={() => removeSection(s.id!)}>
                    Remove the section (keep its football)
                  </MenuItem>
                </MenuButton>
              </div>
              {s.item_ids.length > 0 ? (
                <ol className={styles.items}>{s.item_ids.map((iid) => row(install.items.find((i) => i.id === iid)!, s.item_ids))}</ol>
              ) : (
                <p className={styles.quiet}>Nothing here yet - use “Move to {s.title}” on any item.</p>
              )}
            </section>
          ))}
        </>
      )}

      {newSection !== null && (
        <form
          className={styles.inlineForm}
          onSubmit={(e) => {
            e.preventDefault();
            if (!newSection.trim()) return;
            void saveLayout({ ...layout, sections: [...layout.sections, { id: null, title: newSection.trim(), item_ids: [] }] });
            setNewSection(null);
          }}
        >
          <input
            className={nb.input}
            value={newSection}
            onChange={(e) => setNewSection(e.target.value)}
            placeholder="Base, Third down, Red zone…"
            aria-label="Section name"
            maxLength={80}
            autoFocus
          />
          <button type="submit" className={nb.btnPrimary}>
            Add section
          </button>
          <button type="button" className={nb.btnSecondary} onClick={() => setNewSection(null)}>
            Cancel
          </button>
        </form>
      )}

      {teachingAt !== null && (
        <InstallMeeting
          install={install}
          startAt={teachingAt}
          groupNeeds={groupNeeds}
          groupLabel={group?.name ?? null}
          onClose={() => setTeachingAt(null)}
        />
      )}
    </div>
  );
}
