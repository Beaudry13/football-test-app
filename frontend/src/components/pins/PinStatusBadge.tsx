import type { PinStatus } from '../../api/types';
import nb from '../../styles/notebook.module.css';

/** Whether a player has a PIN - never the PIN itself, which Peira cannot show
 *  again once its sheet is closed.
 *
 *  Renders nothing when the status is unknown, so a payload from before this
 *  field existed shows no badge rather than a wrong one. "No PIN" and "Locked"
 *  are the two a coach may need to act on, so they carry the warning style;
 *  "PIN set" is the calm, expected state. */
export function PinStatusBadge({ status }: { status?: PinStatus }) {
  if (!status) return null;
  if (status === 'set') return <span className={`${nb.badge} ${nb.badgeNeutral}`}>PIN set</span>;
  if (status === 'locked') return <span className={`${nb.badge} ${nb.badgeWarning}`}>Locked</span>;
  return <span className={`${nb.badge} ${nb.badgeWarning}`}>No PIN</span>;
}
