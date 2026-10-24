import { useId, useState } from 'react';
import { getErrorMessage } from '../../api/client';
import nb from '../../styles/notebook.module.css';

/**
 * A NEXT STEP THAT TAKES A MOMENT - building a retest, making a rep: says it
 * is working, and when it fails says so on the button - with the reason
 * beside it - so a tap never just resets with nothing said. The page decides
 * where a success goes.
 */
export function StepButton({
  label,
  run,
  className,
  busyLabel = 'Building…',
}: {
  label: string;
  run: () => Promise<void>;
  className?: string;
  busyLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const reasonId = useId();
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={busy}
        title={failed ?? undefined}
        aria-describedby={failed ? reasonId : undefined}
        onClick={async () => {
          setBusy(true);
          setFailed(null);
          try {
            await run();
          } catch (err) {
            setFailed(getErrorMessage(err));
            setBusy(false);
          }
        }}
      >
        {busy ? busyLabel : failed ? `${label} - try again` : label}
      </button>
      {failed && (
        <span id={reasonId} role="alert" className={nb.srOnly}>
          {failed}
        </span>
      )}
    </>
  );
}
