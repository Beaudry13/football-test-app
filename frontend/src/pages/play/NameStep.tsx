import { useState } from 'react';
import styles from './PlayPage.module.css';

export function NameStep({
  quizTitle,
  rosterPlayers,
  onSelected,
}: {
  quizTitle: string;
  rosterPlayers: string[];
  onSelected: (name: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className={`card ${styles.panel}`}>
      <h2>{quizTitle}</h2>
      <p>Select your name from the roster.</p>
      <div className={styles.nameGrid}>
        {rosterPlayers.map((name) => (
          <button
            key={name}
            className={`${styles.nameButton} ${selected === name ? styles.nameButtonActive : ''}`}
            onClick={() => setSelected(name)}
          >
            {name}
          </button>
        ))}
      </div>
      <button
        className="btn btn-primary"
        disabled={!selected}
        style={{ width: '100%' }}
        onClick={() => selected && onSelected(selected)}
      >
        Continue
      </button>
    </div>
  );
}
