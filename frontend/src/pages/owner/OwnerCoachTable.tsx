import type { OwnerCoachRow } from '../../api/types';
import { count, exactTime, relativeDay, shortDate } from './ownerFormat';
import styles from './Owner.module.css';

/** The coach table, shared by the platform-wide Coaches page and the
 *  organization detail page.
 *
 * Shared deliberately: both answer the same question about the same records,
 * and two copies would eventually label "Last attributed activity" two
 * different ways - which is precisely the column where wording is the whole
 * meaning. */
export function OwnerCoachTable({
  coaches,
  showOrganization = true,
}: {
  coaches: OwnerCoachRow[];
  /** Hidden on the organization detail page, where every row shares one. */
  showOrganization?: boolean;
}) {
  if (coaches.length === 0) {
    return (
      <div className={styles.tableWrap}>
        <p className={styles.empty}>No coaches match.</p>
      </div>
    );
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Coach</th>
            <th>Email</th>
            {showOrganization && <th>Organization</th>}
            <th>Org role</th>
            <th>Joined</th>
            <th className={styles.num}>Quizzes created</th>
            <th>Last attributed activity</th>
          </tr>
        </thead>
        <tbody>
          {coaches.map((coach) => (
            <tr key={coach.id}>
              <td>
                {coach.username}{' '}
                {coach.is_platform_owner && (
                  <span
                    className={`${styles.tag} ${styles.tagOwner}`}
                    title="Peira platform owner"
                  >
                    Owner
                  </span>
                )}
              </td>
              <td>{coach.email}</td>
              {showOrganization && <td>{coach.organization_name}</td>}
              <td>
                <span className={styles.tag}>{coach.role}</span>
              </td>
              <td title={exactTime(coach.joined_at)}>{shortDate(coach.joined_at)}</td>
              <td className={styles.num}>{count(coach.quizzes_created)}</td>
              {/* An em dash means "nothing attributable exists", NOT
                  "inactive". See the note rendered beneath every table that
                  uses this column. */}
              <td
                className={coach.last_attributed_activity ? undefined : styles.unknown}
                title={exactTime(coach.last_attributed_activity)}
              >
                {relativeDay(coach.last_attributed_activity)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The definition, rendered wherever the column appears.
 *
 * Not a tooltip: this number is easy to misread as "last seen", and the
 * consequence of misreading it is concluding that a paying customer has
 * churned. It is stated in full, on screen, every time. */
export function AttributedActivityNote() {
  return (
    <p className={styles.sectionNote}>
      <strong>Last attributed activity</strong> is the most recent action Peira can attribute to
      this specific coach: a quiz they created, a playbook they uploaded, or an answer they graded.
      It is <em>not</em> a login or &ldquo;last seen&rdquo; &mdash; Peira records neither. It
      undercounts: a coach who signs in regularly to read results but never creates, uploads or
      grades shows &ldquo;{'—'}&rdquo;. Activating an access code is also not attributable, because
      access codes do not record which coach sent them.
    </p>
  );
}
