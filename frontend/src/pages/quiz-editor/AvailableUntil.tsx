import { useState } from 'react';
import { PRESETS, describe, toLocalInputValue } from './availableUntilTimes';
import nb from '../../styles/notebook.module.css';
import styles from './AvailableUntil.module.css';

/**
 * When a Peira stops being available.
 *
 * THE WHOLE FEATURE IS "AVAILABLE UNTIL". Not a TTL, not an expiration policy,
 * not an access window - one moment, in the words a coach would use. A Peira
 * shared on Thursday for Saturday morning used to be dead before anyone opened
 * it, because activation hardcoded 24 hours.
 *
 * A DEFAULT IS ALWAYS SELECTED, so activating never requires a decision. The
 * common case - "we're doing this today" - is exactly what the old fixed
 * window already did, so it stays the default and the coach who does not care
 * clicks Activate as before.
 *
 * PRESETS, NOT A DURATION PICKER. A coach thinks "before Saturday's walk-
 * through", never "in 44 hours". The presets resolve to a real moment and the
 * summary reads it back as a day and a time, so what is chosen and what is
 * shown are the same sentence. The exact picker is one click away for the
 * cases the presets do not cover, rather than being the thing everyone meets.
 *
 * THE CONVERSION HAPPENS HERE, IN THE BROWSER, and that is deliberate. The
 * browser owns a real IANA timezone database, so DST and travel are already
 * correct; the value handed upward is an absolute Date, and the server never
 * has to guess what "9:00 PM" meant. Peira stores no coach timezone, and this
 * is the reason it does not need one yet.
 */

export function AvailableUntil({
  value,
  onChange,
  label = 'Available until',
}: {
  value: Date;
  onChange: (when: Date) => void;
  label?: string;
}) {
  const [showExact, setShowExact] = useState(false);

  const isPast = value.getTime() <= Date.now();

  return (
    <div className={styles.block}>
      <div className={styles.summaryRow}>
        <span className={styles.label}>{label}</span>
        <strong className={styles.summary}>{describe(value)}</strong>
      </div>

      <div className={styles.presets} role="group" aria-label={label}>
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className={styles.preset}
            onClick={() => {
              setShowExact(false);
              onChange(preset.at());
            }}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          className={styles.exactToggle}
          onClick={() => setShowExact((open) => !open)}
          aria-expanded={showExact}
        >
          {showExact ? 'Hide' : 'Pick date & time'}
        </button>
      </div>

      {showExact && (
        <input
          type="datetime-local"
          className={nb.input}
          aria-label="Available until date and time"
          value={toLocalInputValue(value)}
          onChange={(e) => {
            // An empty or half-typed value parses as Invalid Date; ignoring it
            // keeps the summary showing the last real choice rather than
            // flashing "Invalid Date" while somebody types.
            const parsed = new Date(e.target.value);
            if (!Number.isNaN(parsed.getTime())) onChange(parsed);
          }}
        />
      )}

      {isPast && (
        /* Said here rather than only after a failed request: a coach should
           not have to press Activate to find out the time they picked has
           already gone. The server refuses it too - this is the courtesy, that
           is the rule. */
        <p className={styles.warning}>That time has already passed. Pick a later one.</p>
      )}
    </div>
  );
}
