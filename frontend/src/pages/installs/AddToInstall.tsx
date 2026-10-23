import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { getErrorMessage } from '../../api/client';
import { addToInstall, createInstall, installsFor, type InstallItemKind } from '../../api/installs';
import styles from './AddToInstall.module.css';

/**
 * ADD TO INSTALL, from where the football is - a play in Motion Lab, a Rep, a
 * quiz, a concept on Results. It opens on his active installs (✓ where it is
 * already in), adds with one tap, and starts a new install right there when
 * this week has none yet. Nothing is copied: the install refers to this
 * football.
 *
 * The panel alone, for a screen that opens its own panels (Motion Lab's "Use
 * this play"); it closes on Escape or a tap outside it.
 */
export function AddToInstallPanel({
  kind,
  refId,
  onClose,
  align = 'right',
}: {
  kind: InstallItemKind;
  refId: number;
  onClose: () => void;
  /** Which edge of its trigger it hangs from - left when the trigger is near the screen's left edge. */
  align?: 'left' | 'right';
}) {
  const [installs, setInstalls] = useState<{ id: number; title: string; has: boolean }[] | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<number | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    let live = true;
    installsFor(kind, refId)
      .then((list) => live && setInstalls(list))
      .catch((err) => live && setError(getErrorMessage(err)));
    return () => {
      live = false;
    };
  }, [kind, refId]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      // The trigger that opened it toggles it itself.
      const host = panel.current?.parentElement;
      if (host && !host.contains(e.target as Node)) close.current();
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, []);

  const add = async (id: number) => {
    setBusy(id);
    setError(null);
    try {
      await addToInstall(id, kind, refId);
      setInstalls((list) => (list ?? []).map((i) => (i.id === id ? { ...i, has: true } : i)));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const createAndAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy('new');
    setError(null);
    try {
      const made = await createInstall({ title: title.trim() });
      await addToInstall(made.id, kind, refId);
      setInstalls((list) => [{ id: made.id, title: made.title, has: true }, ...(list ?? [])]);
      setTitle('');
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      ref={panel}
      className={styles.panel}
      data-align={align}
      role="dialog"
      aria-label="Add to install"
      onKeyDown={(e) => {
        // A screen's own keys (Motion Lab's editor) stay out of it.
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
    >
      <span className={styles.head}>Add to install</span>
      {installs === null && !error && <span className={styles.note}>Finding your installs…</span>}
      {(installs ?? []).map((i) => (
        <span key={i.id} className={styles.row}>
          <span className={styles.title}>{i.title}</span>
          {i.has ? (
            <Link to={`/installs/${i.id}`} className={styles.in}>
              ✓ In it
            </Link>
          ) : (
            <button type="button" className={styles.add} disabled={busy !== null} onClick={() => void add(i.id)}>
              {busy === i.id ? 'Adding…' : 'Add'}
            </button>
          )}
        </span>
      ))}
      <form className={styles.newRow} onSubmit={(e) => void createAndAdd(e)}>
        <input
          className={styles.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={installs && installs.length > 0 ? 'Or a new install…' : 'Week 7 - Central'}
          aria-label="New install name"
          maxLength={120}
        />
        <button type="submit" className={styles.add} disabled={busy !== null || !title.trim()}>
          {busy === 'new' ? 'Starting…' : 'Start'}
        </button>
      </form>
      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** The quiet control and its panel, for a page header or a "More" menu. */
export function AddToInstall({
  kind,
  refId,
  label = 'Add to install',
  className,
}: {
  kind: InstallItemKind;
  refId: number;
  label?: string;
  /** The trigger's class, so it sits in the bar it is part of. */
  className?: string;
}) {
  const [open, setOpen] = useState<'left' | 'right' | null>(null);
  return (
    <span className={styles.wrap}>
      <button
        type="button"
        className={className}
        aria-expanded={open !== null}
        aria-haspopup="dialog"
        // It hangs toward the side with room for it - a phone's narrow width too.
        onClick={(e) => setOpen((o) => (o ? null : e.currentTarget.getBoundingClientRect().right < 320 ? 'left' : 'right'))}
      >
        {label}
      </button>
      {open && <AddToInstallPanel kind={kind} refId={refId} align={open} onClose={() => setOpen(null)} />}
    </span>
  );
}
