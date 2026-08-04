import { useState } from 'react';
import nb from '../styles/notebook.module.css';
import styles from './ImportHelperCard.module.css';

export const AI_ROSTER_PROMPT =
  'Convert this roster into a CSV file with these columns:\nFirst Name\nLast Name\nJersey Number\nPosition.';

const COPIED_FEEDBACK_MS = 2000;

/** Instructional helper shown inside the Import Roster panel for coaches
 * who don't already have a CSV. Purely informational - Peira doesn't talk
 * to ChatGPT/Claude directly, this just tells a coach the fastest path to
 * get from "some roster in a PDF/website/spreadsheet" to a file this panel
 * already knows how to read. */
export function ImportHelperCard() {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'fallback'>('idle');

  async function handleCopyPrompt() {
    if (!navigator.clipboard) {
      setCopyState('fallback');
      return;
    }
    try {
      await navigator.clipboard.writeText(AI_ROSTER_PROMPT);
      setCopyState('copied');
      setTimeout(() => setCopyState((s) => (s === 'copied' ? 'idle' : s)), COPIED_FEEDBACK_MS);
    } catch {
      setCopyState('fallback');
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.headerRow}>
        <span className={styles.icon} aria-hidden="true">
          ℹ
        </span>
        <h4 className={styles.title}>Need Help Creating a CSV?</h4>
      </div>

      <p>If you don't already have a CSV, it's easy.</p>
      <p>
        Copy your roster from a website, PDF, Excel spreadsheet, Google Sheet, or another source into
        ChatGPT or Claude.
      </p>
      <p>Ask:</p>
      <blockquote className={styles.promptQuote}>
        "Convert this roster into a CSV file with these columns:
        <br />
        First Name
        <br />
        Last Name
        <br />
        Jersey Number
        <br />
        Position"
      </blockquote>
      <p>Download the CSV it creates and upload it here.</p>
      <p>
        You can also copy rows directly from Excel or Google Sheets and paste them into Peira without
        creating a CSV.
      </p>

      <div className={styles.copyRow}>
        <button type="button" className={nb.btnSm} onClick={handleCopyPrompt}>
          {copyState === 'copied' ? '✓ Prompt Copied' : 'Copy AI Prompt'}
        </button>
      </div>

      {copyState === 'fallback' && (
        <div className={styles.fallback}>
          <p>Clipboard access isn't available here - copy the prompt below manually:</p>
          <textarea
            className={styles.fallbackText}
            readOnly
            value={AI_ROSTER_PROMPT}
            aria-label="AI roster conversion prompt"
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      )}

      <details className={styles.example}>
        <summary>See Example</summary>
        <div className={styles.exampleBody}>
          <p className={styles.exampleLabel}>Original roster</p>
          <pre className={styles.exampleBlock}>{'2  John Smith    S\n5  Marcus Brown  CB\n12 Chris Jones   LB'}</pre>
          <p className={styles.exampleArrow} aria-hidden="true">
            ↓
          </p>
          <p className={styles.exampleLabel}>CSV</p>
          <pre className={styles.exampleBlock}>
            {'First Name,Last Name,Jersey Number,Position\nJohn,Smith,2,S\nMarcus,Brown,5,CB\nChris,Jones,12,LB'}
          </pre>
        </div>
      </details>

      <p className={styles.waysToImport}>
        Three ways to import: upload an existing CSV, paste spreadsheet rows directly into Peira, or use
        ChatGPT or Claude to convert another roster format into a CSV first. AI tools aren't required, and
        Peira doesn't connect to them directly - this is just a shortcut for coaches who don't have a CSV
        yet.
      </p>
    </div>
  );
}
