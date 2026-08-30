import { useState } from 'react';
import { addGroupMembers, removeGroupMember } from '../api/players';
import { getErrorMessage } from '../api/client';
import { ErrorBanner } from '../components/ErrorBanner';
import type { Group } from '../api/types';
import styles from './PlayerGroups.module.css';

/** WHICH GROUPS THIS PLAYER IS IN, AND HOW TO CHANGE THEM.
 *
 * MEMBERSHIP, NOT A MOVE. A safety is legitimately in Defense and Safeties
 * and Special Teams and Travel at once, so every group is an independent
 * toggle rather than one "move to" choice. Adding one never removes another;
 * removing one never touches the rest.
 *
 * NOTHING HERE TOUCHES IDENTITY. These calls add and remove rows in
 * group_players. The Player's id, their attempts, their results, their
 * concepts, their retests, the player_name snapshot on every past attempt and
 * position_at_attempt are all untouched by a membership change - which is the
 * entire reason a coach can reorganise the roster freely.
 *
 * The group side keeps its bulk editor. That answers "who is in Safeties";
 * this answers "what is John in". Both write the same rows.
 */
export function PlayerGroups({
  playerId,
  allGroups,
  memberOf,
  onChanged,
}: {
  playerId: number;
  /** Every group in the organization, in the order the API returned them. */
  allGroups: Group[];
  /** The groups this player is currently in. */
  memberOf: { id: number; name: string }[];
  /** Refetch the profile - the server is the source of truth for membership,
   *  so nothing here keeps its own copy of it. */
  onChanged: () => Promise<void> | void;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const memberIds = new Set(memberOf.map((g) => g.id));

  async function toggle(group: Group) {
    const isMember = memberIds.has(group.id);
    setError(null);
    setBusyId(group.id);
    try {
      if (isMember) {
        await removeGroupMember(group.id, playerId);
      } else {
        await addGroupMembers(group.id, [playerId]);
      }
      await onChanged();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  if (allGroups.length === 0) {
    return (
      <section className={styles.groups}>
        <h2 className={styles.heading}>Groups</h2>
        <p className={styles.empty}>
          No groups yet. Create one from Team &rarr; Groups to organise players.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.groups}>
      <h2 className={styles.heading}>Groups</h2>
      <ErrorBanner message={error} />
      <ul className={styles.list}>
        {allGroups.map((group) => {
          const isMember = memberIds.has(group.id);
          return (
            <li key={group.id}>
              <button
                type="button"
                className={`${styles.chip} ${isMember ? styles.chipOn : ''}`}
                // The control IS the state, so it reports its own. A separate
                // "Groups: A, B" line plus a set of buttons would be two
                // places to read the same fact, able to disagree mid-save.
                aria-pressed={isMember}
                disabled={busyId === group.id}
                onClick={() => void toggle(group)}
              >
                <span aria-hidden="true" className={styles.mark}>
                  {isMember ? '✓' : '+'}
                </span>
                {group.name}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
