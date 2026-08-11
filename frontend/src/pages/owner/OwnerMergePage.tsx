import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { executeMerge, listOwnerOrganizations, previewMerge } from '../../api/owner';
import { getErrorMessage } from '../../api/client';
import type { MergePreview, OwnerOrganizationRow } from '../../api/types';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LoadingState } from '../../components/ui/LoadingState';
import { count } from './ownerFormat';
import styles from './Owner.module.css';

const MOVED_ROWS: { key: keyof MergePreview['source']['counts']; label: string }[] = [
  { key: 'coaches', label: 'Coaches' },
  { key: 'players', label: 'Players' },
  { key: 'quizzes', label: 'Quizzes' },
  { key: 'questions', label: 'Questions' },
  { key: 'access_codes', label: 'Access codes' },
  { key: 'graded_attempts', label: 'Graded attempts' },
  { key: 'practice_attempts', label: 'Practice attempts' },
  { key: 'answers', label: 'Answers' },
  { key: 'answer_drawings', label: 'Drawings' },
  { key: 'groups', label: 'Groups' },
  { key: 'folders', label: 'Folders' },
  { key: 'playbooks', label: 'Playbooks' },
  { key: 'document_pages', label: 'Playbook pages' },
];

/** Merge one organization into another.
 *
 * DELIBERATELY HARD TO DO BY ACCIDENT. The direction is never inferred - the
 * destination is the organization you opened, the source is chosen explicitly,
 * and the confirmation requires typing the source's name. The final button
 * names both organizations rather than saying "Confirm", because "Confirm"
 * tells you nothing about which one disappears.
 *
 * Every warning the server reports must be acknowledged here before the
 * button enables. The server enforces the same rules again - this screen is
 * the explanation, not the guard. */
export function OwnerMergePage() {
  const { organizationId } = useParams<{ organizationId: string }>();
  const destinationId = Number(organizationId);

  const [organizations, setOrganizations] = useState<OwnerOrganizationRow[] | null>(null);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [roles, setRoles] = useState<Record<number, 'ADMIN' | 'MEMBER'>>({});
  const [ackCollisions, setAckCollisions] = useState(false);
  const [ackDuplicates, setAckDuplicates] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    listOwnerOrganizations()
      .then((r) => setOrganizations(r.organizations))
      .catch((e) => setError(getErrorMessage(e)));
  }, []);

  const loadPreview = useCallback(
    (nextRoles: Record<number, 'ADMIN' | 'MEMBER'>) => {
      if (!sourceId) return;
      setError(null);
      previewMerge({
        source_organization_id: sourceId,
        destination_organization_id: destinationId,
        coach_roles: Object.fromEntries(
          Object.entries(nextRoles).map(([id, role]) => [String(id), role]),
        ),
      })
        .then(setPreview)
        .catch((e) => {
          setPreview(null);
          setError(getErrorMessage(e));
        });
    },
    [sourceId, destinationId],
  );

  useEffect(() => {
    if (sourceId) loadPreview(roles);
    // Re-previewing on every role change is the point: the operator sees the
    // consequence of keeping an ADMIN before they commit to it.
  }, [sourceId, roles, loadPreview]);

  const needsCollisionAck = preview?.requires_acknowledgement.collisions ?? false;
  const needsDuplicateAck = preview?.requires_acknowledgement.duplicate_players ?? false;

  const ready = useMemo(() => {
    if (!preview || busy) return false;
    if (needsCollisionAck && !ackCollisions) return false;
    if (needsDuplicateAck && !ackDuplicates) return false;
    // Typing the source name is the last gate, and it is exact.
    return typed.trim() === preview.source.name;
  }, [preview, busy, needsCollisionAck, ackCollisions, needsDuplicateAck, ackDuplicates, typed]);

  function handleMerge() {
    if (!preview || !sourceId) return;
    setBusy(true);
    setError(null);
    executeMerge({
      source_organization_id: sourceId,
      destination_organization_id: destinationId,
      fingerprint: preview.fingerprint,
      coach_roles: Object.fromEntries(
        Object.entries(roles).map(([id, role]) => [String(id), role]),
      ),
      acknowledge_collisions: ackCollisions,
      acknowledge_duplicate_players: ackDuplicates,
    })
      .then((result) => setDone(`${result.source.name} was merged into ${result.destination.name}.`))
      .catch((e) => setError(getErrorMessage(e)))
      .finally(() => setBusy(false));
  }

  if (done) {
    return (
      <div>
        <div className={styles.detailHead}>
          <h2 className={styles.detailName}>Merge complete</h2>
          <p className={styles.sectionNote}>{done}</p>
        </div>
        <Link className={styles.backLink} to="/owner/organizations">
          ← All organizations
        </Link>
      </div>
    );
  }

  const destination = organizations?.find((o) => o.id === destinationId);
  const candidates = (organizations ?? []).filter((o) => o.id !== destinationId);

  return (
    <div>
      <Link className={styles.backLink} to={`/owner/organizations/${destinationId}`}>
        ← Back to organization
      </Link>

      <div className={styles.detailHead}>
        <h2 className={styles.detailName}>Merge organization</h2>
        <p className={styles.sectionNote}>
          Moves everything from the source into the destination, then deletes the source. Nothing
          is renamed, combined or deduplicated. This cannot be undone.
        </p>
      </div>

      <ErrorBanner message={error} />

      <section className={styles.section}>
        <h3 className={styles.sectionHeading}>Destination — survives</h3>
        <p className={styles.detailName}>{destination?.name ?? `Organization ${destinationId}`}</p>

        <h3 className={styles.sectionHeading} style={{ marginTop: 16 }}>
          Source — will be removed
        </h3>
        {!organizations ? (
          <LoadingState variant="inline" />
        ) : (
          <select
            className={styles.search}
            aria-label="Source organization"
            value={sourceId ?? ''}
            onChange={(e) => {
              setSourceId(e.target.value ? Number(e.target.value) : null);
              setRoles({});
              setTyped('');
              setAckCollisions(false);
              setAckDuplicates(false);
            }}
          >
            <option value="">Select an organization to merge in…</option>
            {candidates.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        )}
      </section>

      {preview && (
        <>
          <div className={styles.detailHead}>
            <p className={styles.detailMeta}>
              <strong>{preview.source.name}</strong> WILL BE REMOVED. Everything below moves into{' '}
              <strong>{preview.destination.name}</strong>.
            </p>
          </div>

          <section className={styles.section}>
            <h3 className={styles.sectionHeading}>What moves</h3>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Record</th>
                    <th className={styles.num}>Moving</th>
                    <th className={styles.num}>Destination now</th>
                    <th className={styles.num}>After merge</th>
                  </tr>
                </thead>
                <tbody>
                  {MOVED_ROWS.map((row) => (
                    <tr key={row.key}>
                      <td>{row.label}</td>
                      <td className={styles.num}>{count(preview.source.counts[row.key])}</td>
                      <td className={styles.num}>{count(preview.destination.counts[row.key])}</td>
                      <td className={styles.num}>
                        {count(preview.resulting_destination_counts[row.key])}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>Invitations</td>
                    <td className={styles.num}>{count(preview.invitations_to_revoke)}</td>
                    <td className={styles.num}>—</td>
                    <td className={styles.num}>revoked</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionHeading}>Coach roles</h3>
            <p className={styles.sectionNote}>
              Every source coach becomes a <strong>MEMBER</strong> by default. Keeping ADMIN gives
              that coach Admin View over {preview.destination.name}&rsquo;s quizzes and results —
              choose it deliberately.
            </p>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Coach</th>
                    <th>Email</th>
                    <th>Current</th>
                    <th>After merge</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.coaches.map((coach) => (
                    <tr key={coach.coach_id}>
                      <td>{coach.username}</td>
                      <td>{coach.email}</td>
                      <td>
                        <span className={styles.tag}>
                          {coach.current_role} — {preview.source.name}
                        </span>
                      </td>
                      <td>
                        <select
                          aria-label={`Role for ${coach.email} after merge`}
                          value={coach.new_role}
                          onChange={(e) =>
                            setRoles((prev) => ({
                              ...prev,
                              [coach.coach_id]: e.target.value as 'ADMIN' | 'MEMBER',
                            }))
                          }
                        >
                          <option value="MEMBER">MEMBER — {preview.destination.name}</option>
                          <option value="ADMIN">ADMIN — {preview.destination.name}</option>
                        </select>
                        {coach.widens_access && (
                          <span className={`${styles.tag} ${styles.tagEmpty}`}>Widens access</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {preview.warnings.length > 0 && (
            <section className={styles.section}>
              <h3 className={styles.sectionHeading}>Warnings</h3>
              <ul className={styles.sectionNote}>
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </section>
          )}

          {needsDuplicateAck && (
            <section className={styles.section}>
              <h3 className={styles.sectionHeading}>Possible duplicate players</h3>
              <p className={styles.sectionNote}>
                These names appear in both organizations. They are <strong>not</strong> combined —
                each keeps its own id and history. Same name is not proof of the same person.
              </p>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th className={styles.num}>Source ids</th>
                      <th className={styles.num}>Destination ids</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.possible_duplicate_players.map((d) => (
                      <tr key={d.normalized_name}>
                        <td>{d.normalized_name}</td>
                        <td className={styles.num}>{d.source_player_ids.join(', ')}</td>
                        <td className={styles.num}>{d.destination_player_ids.join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label className={styles.sectionNote}>
                <input
                  type="checkbox"
                  checked={ackDuplicates}
                  onChange={(e) => setAckDuplicates(e.target.checked)}
                />{' '}
                I understand these players will remain separate people.
              </label>
            </section>
          )}

          {needsCollisionAck && (
            <section className={styles.section}>
              <h3 className={styles.sectionHeading}>Name collisions</h3>
              <p className={styles.sectionNote}>
                Both copies survive. Nothing is renamed, overwritten or deduplicated.
              </p>
              <ul className={styles.sectionNote}>
                {preview.name_collisions.map((c) => (
                  <li key={`${c.type}-${c.name}`}>
                    {c.type}: <strong>{c.name}</strong>
                  </li>
                ))}
              </ul>
              <label className={styles.sectionNote}>
                <input
                  type="checkbox"
                  checked={ackCollisions}
                  onChange={(e) => setAckCollisions(e.target.checked)}
                />{' '}
                I understand both copies will survive.
              </label>
            </section>
          )}

          <section className={styles.section}>
            <h3 className={styles.sectionHeading}>Confirm</h3>
            <p className={styles.sectionNote}>
              Type <strong>{preview.source.name}</strong> to enable the merge.
            </p>
            <input
              className={styles.search}
              aria-label="Type the source organization name to confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={preview.source.name}
            />
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className={`${styles.toggle} ${ready ? styles.toggleActive : ''}`}
                disabled={!ready}
                onClick={handleMerge}
              >
                {busy
                  ? 'Merging…'
                  : `Merge ${preview.source.name} into ${preview.destination.name}`}
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
