import { useState } from 'react';
import { Link } from 'react-router-dom';
import { rememberedCodes } from './workProgress';
import styles from './PlayPage.module.css';

/**
 * WHAT'S NEXT, AFTER THIS ONE: a quiet way back to Player Home from a finish
 * screen - only when this device holds other work, so a player with one code
 * is never sent to an empty page.
 */
export function OtherWorkLink({ code }: { code: string }) {
  const [others] = useState(() => rememberedCodes().filter((c) => c !== code.trim().toUpperCase()).length);
  if (others === 0) return null;
  return (
    <Link to="/play" className={styles.otherWork}>
      Your other work →
    </Link>
  );
}
