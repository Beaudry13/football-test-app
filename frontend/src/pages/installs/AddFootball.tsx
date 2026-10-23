import { useEffect, useMemo, useState } from 'react';
import { listConcepts, type Concept } from '../../api/concepts';
import type { Install, InstallItemKind } from '../../api/installs';
import { listMotionPlays, type MotionPlayRow } from '../../api/motionLab';
import { listQuizzes } from '../../api/quizzes';
import type { Quiz } from '../../api/types';
import styles from './Installs.module.css';

type Filter = 'recent' | 'plays' | 'reps' | 'quizzes' | 'concepts';

interface Entry {
  kind: InstallItemKind;
  refId: number;
  tag: string;
  title: string;
  meta: string;
  updated: string;
}

/** How many rows the finder shows at once - search narrows the rest. */
const SHOWN = 30;

/**
 * ADD FOOTBALL: find what he already has and add it - recent first, or just
 * his plays, Reps, quizzes or concepts, narrowed by a few typed letters. The
 * lists PEIRA already loads elsewhere; no search engine. What is already in
 * the install says so.
 */
export function AddFootball({
  install,
  motionLab,
  onAdd,
  onClose,
}: {
  install: Install;
  motionLab: boolean;
  onAdd: (kind: InstallItemKind, refId: number) => Promise<void>;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('recent');
  const [search, setSearch] = useState('');
  const [plays, setPlays] = useState<MotionPlayRow[]>([]);
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([
      motionLab ? listMotionPlays().catch(() => []) : Promise.resolve([] as MotionPlayRow[]),
      listQuizzes().catch(() => [] as Quiz[]),
      listConcepts().catch(() => [] as Concept[]),
    ]).then(([p, q, c]) => {
      if (!live) return;
      setPlays(p);
      setQuizzes(q);
      setConcepts(c.filter((x) => !x.is_archived));
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [motionLab]);

  const inInstall = useMemo(() => new Set(install.items.map((i) => `${i.kind}:${i.ref_id}`)), [install.items]);
  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [
      ...plays.map((p) => ({ kind: 'play' as const, refId: p.id, tag: 'Play', title: p.name, meta: 'Motion Lab', updated: p.updated_at })),
      ...quizzes.map((q) => ({
        kind: 'quiz' as const,
        refId: q.id,
        tag: q.kind === 'REP' ? 'Rep' : 'Quiz',
        title: q.title,
        meta: `${q.question_count} ${q.kind === 'REP' ? (q.question_count === 1 ? 'decision' : 'decisions') : q.question_count === 1 ? 'question' : 'questions'}`,
        updated: q.updated_at,
      })),
      ...concepts.map((c) => ({ kind: 'concept' as const, refId: c.id, tag: 'Concept', title: c.name, meta: 'Concept', updated: '' })),
    ];
    const byFilter = out.filter((e) =>
      filter === 'recent' ? e.kind !== 'concept' : filter === 'plays' ? e.kind === 'play' : filter === 'concepts' ? e.kind === 'concept' : e.tag === (filter === 'reps' ? 'Rep' : 'Quiz'),
    );
    const needle = search.trim().toLowerCase();
    const found = needle ? byFilter.filter((e) => e.title.toLowerCase().includes(needle)) : byFilter;
    return filter === 'concepts' ? found.sort((a, b) => a.title.localeCompare(b.title)) : found.sort((a, b) => b.updated.localeCompare(a.updated));
  }, [plays, quizzes, concepts, filter, search]);

  const filters: [Filter, string][] = [
    ['recent', 'Recent'],
    ...(motionLab ? ([['plays', 'Plays']] as [Filter, string][]) : []),
    ['reps', 'Reps'],
    ['quizzes', 'Quizzes'],
    ['concepts', 'Concepts'],
  ];

  return (
    <section className={styles.finder} aria-label="Add football">
      <div className={styles.finderHead}>
        <strong>Add football</strong>
        <button type="button" className={styles.linkButton} onClick={onClose}>
          Done
        </button>
      </div>
      <div className={styles.filters} role="group" aria-label="Show">
        {filters.map(([key, label]) => (
          <button key={key} type="button" className={styles.filter} aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
        <input
          className={styles.search}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find…"
          aria-label="Find football"
        />
      </div>
      {loading ? (
        <p className={styles.quiet}>Getting your football…</p>
      ) : entries.length === 0 ? (
        <p className={styles.quiet}>{search ? 'Nothing by that name.' : 'Nothing here yet.'}</p>
      ) : (
        <ul className={styles.finderList}>
          {entries.slice(0, SHOWN).map((e) => {
            const key = `${e.kind}:${e.refId}`;
            const added = inInstall.has(key);
            return (
              <li key={`${e.tag}:${e.refId}`} className={styles.finderRow}>
                <span className={styles.tag} data-kind={e.tag.toLowerCase()}>
                  {e.tag}
                </span>
                <span className={styles.finderTitle}>{e.title}</span>
                <span className={styles.finderMeta}>{e.meta}</span>
                {added ? (
                  <span className={styles.added}>✓ Added</span>
                ) : (
                  <button
                    type="button"
                    className={styles.addButton}
                    disabled={adding !== null}
                    onClick={async () => {
                      setAdding(key);
                      try {
                        await onAdd(e.kind, e.refId);
                      } finally {
                        setAdding(null);
                      }
                    }}
                  >
                    {adding === key ? 'Adding…' : 'Add'}
                  </button>
                )}
              </li>
            );
          })}
          {entries.length > SHOWN && <li className={styles.quiet}>and {entries.length - SHOWN} more - type to find one</li>}
        </ul>
      )}
    </section>
  );
}
