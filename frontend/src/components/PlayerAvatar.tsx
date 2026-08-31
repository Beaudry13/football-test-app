import { useState } from 'react';
import { resolveMediaUrl } from '../api/client';
import styles from './PlayerAvatar.module.css';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0][0]!.toUpperCase();
  return (parts[0][0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** A Player's photo, or a generic initials placeholder when there is none
 * or the image fails to load. Purely decorative (empty alt) - every
 * usage already shows the player's name as text alongside it. */
export function PlayerAvatar({
  name,
  photoUrl,
  size = 'md',
  tone = 'brand',
}: {
  name: string;
  photoUrl: string | null | undefined;
  size?: 'sm' | 'md' | 'lg';
  /** `neutral` for long lists, where a column of gold discs stops reading as
   *  accent and starts reading as background. Only affects the initials
   *  placeholder - a real photo is a photo either way. */
  tone?: 'brand' | 'neutral';
}) {
  const [failed, setFailed] = useState(false);
  const sizeClass = styles[size];

  if (!photoUrl || failed) {
    return (
      <div
        className={`${styles.avatar} ${styles.placeholder} ${sizeClass} ${
          tone === 'neutral' ? styles.toneNeutral : ''
        }`}
        aria-hidden="true"
      >
        {initials(name)}
      </div>
    );
  }

  return (
    <img
      className={`${styles.avatar} ${sizeClass}`}
      src={resolveMediaUrl(photoUrl)}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}
