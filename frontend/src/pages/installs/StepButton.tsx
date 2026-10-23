import { useState } from 'react';

/** A next step that takes a moment: says so, and says what went wrong. */
export function StepButton({ label, run }: { label: string; run: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      title={failed ? 'That did not work - try again' : undefined}
      onClick={async () => {
        setBusy(true);
        setFailed(false);
        try {
          await run();
        } catch {
          setFailed(true);
          setBusy(false);
        }
      }}
    >
      {busy ? 'Building…' : failed ? `${label} - try again` : label}
    </button>
  );
}

