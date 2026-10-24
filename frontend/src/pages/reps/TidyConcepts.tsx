import { useEffect, useState } from 'react';
import { getErrorMessage } from '../../api/client';
import { getConceptDuplicates, mergeConcepts, type ConceptDuplicateGroup } from '../../api/concepts';
import { useAuth } from '../../auth/AuthContext';
import { ErrorBanner } from '../../components/ErrorBanner';
import nb from '../../styles/notebook.module.css';
import styles from './TidyConcepts.module.css';

/**
 * ONE "MOTION ADJUSTMENT", NOT FIVE. When concepts look like the same idea
 * (same words, a shortened word, a typo), say so and merge them in one tap
 * into the one the coach keeps: questions retagged, the spellings archived -
 * never deleted, so history still reads. Admins only, as the server requires:
 * it retags teammates' questions too.
 */
export function TidyConcepts({ onMerged }: { onMerged?: () => void }) {
  let admin = false;
  try {
    admin = useAuth().coach?.role === 'admin';
  } catch {
    admin = false;
  }
  const [groups, setGroups] = useState<ConceptDuplicateGroup[] | null>(null);
  const [open, setOpen] = useState(false);
  const [keep, setKeep] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!admin) return;
    getConceptDuplicates()
      .then(setGroups)
      .catch(() => setGroups([]));
  }, [admin]);

  if (!admin || !groups || groups.length === 0) return null;

  const merge = async (index: number, group: ConceptDuplicateGroup) => {
    const keepId = keep[index] ?? group.suggested_keep;
    setBusy(index);
    setError(null);
    try {
      await mergeConcepts(
        keepId,
        group.concepts.map((c) => c.id).filter((id) => id !== keepId),
      );
      setGroups((list) => (list ?? []).filter((_, i) => i !== index));
      onMerged?.();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={styles.tidy} aria-label="Tidy concepts">
      <button type="button" className={styles.lead} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {groups.length === 1 ? 'Some concepts look like the same idea' : `${groups.length} sets of concepts look like the same idea`} - tidy up
      </button>
      {open && (
        <ul className={styles.groups}>
          {groups.map((group, index) => {
            const keepId = keep[index] ?? group.suggested_keep;
            const kept = group.concepts.find((c) => c.id === keepId)!;
            return (
              <li key={group.concepts.map((c) => c.id).join('-')} className={styles.group}>
                <fieldset className={styles.choices}>
                  <legend>Keep which one?</legend>
                  {group.concepts.map((c) => (
                    <label key={c.id} className={styles.choice}>
                      <input
                        type="radio"
                        name={`keep-${index}`}
                        checked={c.id === keepId}
                        onChange={() => setKeep((k) => ({ ...k, [index]: c.id }))}
                      />
                      <span className={styles.name}>{c.name}</span>
                      <span className={styles.count}>
                        {c.question_count} {c.question_count === 1 ? 'question' : 'questions'}
                      </span>
                    </label>
                  ))}
                </fieldset>
                <button type="button" className={nb.btnSm} disabled={busy !== null} onClick={() => void merge(index, group)}>
                  {busy === index ? 'Merging…' : `Merge into “${kept.name}”`}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ErrorBanner message={error} />
    </section>
  );
}
