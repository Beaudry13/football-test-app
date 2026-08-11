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
  // The operator's DECISIONS, not the server's computed roles. `undefined`
  // means "not yet decided", which is a state the server's payload cannot
  // express - it always reports a concrete new_role, defaulting to MEMBER.
  // Binding the control to that value was the bug: it made "defaulted to
  // MEMBER" and "chose MEMBER" indistinguishable, so choosing MEMBER selected
  // an already-selected option and fired no change event at all.
  const [decisions, setDecisions] = useState<Record<number, 'ADMIN' | 'MEMBER'>>({});
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
    (nextDecisions: Record<number, 'ADMIN' | 'MEMBER'>) => {
      if (!sourceId) return;
      setError(null);
      previewMerge({
        source_organization_id: sourceId,
        destination_organization_id: destinationId,
        coach_roles: Object.fromEntries(
          Object.entries(nextDecisions).map(([id, role]) => [String(id), role]),
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
    if (sourceId) loadPreview(decisions);
    // Re-previewing on every decision is the point: the operator sees the
    // consequence of keeping an ADMIN before they commit to it.
  }, [sourceId, decisions, loadPreview]);

  const needsCollisionAck = preview?.requires_acknowledgement.collisions ?? false;
  const needsDuplicateAck = preview?.requires_acknowledgement.duplicate_players ?? false;

  /** Source admins still awaiting an explicit MEMBER/ADMIN decision.
   *
   * The server refuses the merge until every one of these is decided. Before,
   * the UI did not check it at all - so with no collisions and no duplicate
   * players the button enabled on the typed name alone and the refusal only
   * appeared as an error after clicking Merge. */
  const undecided = useMemo(
    () =>
      (preview?.requires_acknowledgement.coach_roles ?? []).filter(
        (id) => decisions[id] === undefined,
      ),
    [preview, decisions],
  );

  const ready = useMemo(() => {
    if (!preview || busy) return false;
    if (preview.blockers.length > 0) return false;
    if (undecided.length > 0) return false;
    if (needsCollisionAck && !ackCollisions) return false;
    if (needsDuplicateAck && !ackDuplicates) return false;
    // Typing the source name is the last gate, and it is exact.
    return typed.trim() === preview.source.name;
  }, [
    preview,
    busy,
    undecided,
    needsCollisionAck,
    ackCollisions,
    needsDuplicateAck,
    ackDuplicates,
    typed,
  ]);

  function handleMerge() {
    if (!preview || !sourceId) return;
    setBusy(true);
    setError(null);
    executeMerge({
      source_organization_id: sourceId,
      destination_organization_id: destinationId,
      fingerprint: preview.fingerprint,
      coach_roles: Object.fromEntries(
        Object.entries(decisions).map(([id, role]) => [String(id), role]),
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
              setDecisions({});
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
            <h3 className={styles.sectionHeading}>Coach roles after merge</h3>
            <p className={styles.sectionNote}>
              Every coach below moves into <strong>{preview.destination.name}</strong>. Keeping
              ADMIN grants that coach Admin View over the destination&rsquo;s quizzes, rosters and
              results — access they do not have today. <strong>Member</strong> is the safe choice,
              but it must be chosen explicitly: nothing is decided for you.
            </p>

            {undecided.length > 0 && (
              <p className={`${styles.sectionNote} ${styles.tagEmpty}`} role="status">
                {undecided.length} coach role decision(s) still required before this merge can run.
              </p>
            )}

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Coach</th>
                    <th>Email</th>
                    <th>Current</th>
                    <th>Role after merge</th>
                    <th>Effect</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.coaches.map((coach) => {
                    const decided = decisions[coach.coach_id];
                    return (
                      <tr key={coach.coach_id}>
                        <td>{coach.username}</td>
                        <td>{coach.email}</td>
                        <td>
                          <span className={styles.tag}>
                            {coach.current_role} — {preview.source.name}
                          </span>
                        </td>
                        <td>
                          {coach.requires_decision ? (
                            // Radios, NOT a select bound to the server's value.
                            // With nothing preselected, choosing Member is a
                            // real event - a select already showing MEMBER
                            // fires no onChange when MEMBER is picked, which
                            // made the safe choice literally unselectable.
                            <fieldset
                              style={{ border: 'none', margin: 0, padding: 0 }}
                              aria-label={`Role for ${coach.email} after merge`}
                            >
                              <label style={{ marginRight: 12 }}>
                                <input
                                  type="radio"
                                  name={`role-${coach.coach_id}`}
                                  value="MEMBER"
                                  checked={decided === 'MEMBER'}
                                  onChange={() =>
                                    setDecisions((prev) => ({
                                      ...prev,
                                      [coach.coach_id]: 'MEMBER',
                                    }))
                                  }
                                />{' '}
                                Member — {preview.destination.name} <em>(recommended)</em>
                              </label>
                              <label>
                                <input
                                  type="radio"
                                  name={`role-${coach.coach_id}`}
                                  value="ADMIN"
                                  checked={decided === 'ADMIN'}
                                  onChange={() =>
                                    setDecisions((prev) => ({
                                      ...prev,
                                      [coach.coach_id]: 'ADMIN',
                                    }))
                                  }
                                />{' '}
                                Admin — {preview.destination.name}
                              </label>
                            </fieldset>
                          ) : (
                            <span className={styles.tag}>
                              {coach.new_role} — {preview.destination.name}
                            </span>
                          )}
                        </td>
                        <td>
                          {coach.requires_decision && decided === undefined ? (
                            <span className={`${styles.tag} ${styles.tagEmpty}`}>
                              Decision required
                            </span>
                          ) : coach.widens_access ? (
                            <span className={`${styles.tag} ${styles.tagEmpty}`}>
                              Widens access
                            </span>
                          ) : (
                            <span className={styles.tag}>Does not widen access</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {preview.blockers.length > 0 && (
            <section className={styles.section}>
              <h3 className={styles.sectionHeading}>Blockers</h3>
              <ul className={`${styles.sectionNote} ${styles.tagEmpty}`}>
                {preview.blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            </section>
          )}

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
            {!ready && preview && (
              <ul className={styles.sectionNote}>
                {undecided.length > 0 && <li>Choose a role for every source coach above.</li>}
                {needsDuplicateAck && !ackDuplicates && (
                  <li>Acknowledge the possible duplicate players.</li>
                )}
                {needsCollisionAck && !ackCollisions && <li>Acknowledge the name collisions.</li>}
                {typed.trim() !== preview.source.name && (
                  <li>Type “{preview.source.name}” exactly.</li>
                )}
              </ul>
            )}
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
