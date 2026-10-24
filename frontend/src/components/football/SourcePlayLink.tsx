import { Link, useLocation } from 'react-router-dom';
import { useMayUseMotionLab } from '../../motion-lab/motionLabAccess';
import { fromHere } from '../../navigation/backTo';

/**
 * OPEN THE PLAY - the source play in Motion Lab, from a question, a decision,
 * an answer being graded or the Teach screen. One name everywhere, only for
 * coaches who can open Motion Lab, and it carries the way back: Motion Lab's
 * top bar then offers "← {this page}" beside Home and Library.
 */
export function SourcePlayLink({
  playId,
  className,
  label = 'Open the play',
}: {
  playId: number | null | undefined;
  className?: string;
  label?: string;
}) {
  const motionLab = useMayUseMotionLab();
  const location = useLocation();
  if (!motionLab || playId == null) return null;
  return (
    <Link to={`/motion-lab/plays/${playId}`} state={fromHere(location)} className={className}>
      {label}
    </Link>
  );
}
