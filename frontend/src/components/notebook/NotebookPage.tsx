import type { ReactNode } from 'react';
import styles from '../../styles/notebook.module.css';

/** Page shell for the dark Peira coach theme: a flat background (see
 * styles/tokens.css --color-bg) with no decorative texture or gradient,
 * per the current design direction ("clean, modern, professional dark UI"
 * - the earlier mouse-tracked gold spotlight + line-art texture overlay
 * was part of the prior, now-superseded ornate treatment and has been
 * removed, not just hidden). Extracted so every reskinned page shares one
 * copy of this shell instead of re-declaring it. */
export function NotebookPage({ children }: { children: ReactNode }) {
  return <div className={styles.page}>{children}</div>;
}
