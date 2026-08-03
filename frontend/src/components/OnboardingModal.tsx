import { PeiraLogo } from './brand/PeiraLogo';
import nb from '../styles/notebook.module.css';
import styles from './OnboardingModal.module.css';

interface OnboardingModalProps {
  onDismiss: () => void;
}

/** "What is Peira?" - explains the Greek meaning behind the name. Shown
 * automatically the first time a coach lands on a notebook-themed page
 * (see NotebookHeader, which owns the open/dismissed state and its
 * localStorage persistence) and re-openable anytime via the header link. */
export function OnboardingModal({ onDismiss }: OnboardingModalProps) {
  return (
    <div className={styles.scrim} onClick={onDismiss}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <div className={styles.mark}>
          <PeiraLogo variant="dark" markOnly size={40} />
        </div>
        <h2 className={styles.heading}>Welcome to Peira</h2>
        <p className={styles.body}>
          In Greek, <em className={styles.emphasis}>peîra</em> (πεῖρα) means{' '}
          <em className={styles.emphasis}>trial, test, proof through experience</em>.
        </p>
        <p className={styles.body}>
          Every quiz you send your team is a trial - a chance for them to prove what they know.
          This is your coach dashboard: build trials, send them to your roster, and track who
          rises to the challenge.
        </p>
        <button className={nb.btnPrimary} onClick={onDismiss}>
          Begin
        </button>
      </div>
    </div>
  );
}
