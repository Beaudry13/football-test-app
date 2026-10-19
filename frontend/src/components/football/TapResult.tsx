import type { PresnapClip } from '../../motion-lab/presnap';
import { PlayPicture } from './PlayPicture';
import type { TapMark, TapOption } from './TapOverlay';
import { usableTargets, type TapTarget } from './tapTargets';
import styles from './TapResult.module.css';

/**
 * A TAP ANSWER, READ BACK - the coach's (or the player's) one-glance view of
 * a miss on the same football picture the player tapped: the right spot in
 * green, his tap in red when it was not the right one, everyone else dimmed.
 * With `counts` it reads a whole team: how many tapped each spot.
 *
 * Null when the question has no usable tap targets - the caller keeps its
 * words-only line.
 */
export function TapResult({
  image,
  presnap,
  targets,
  options,
  correctIds,
  chosenIds = [],
  counts,
  who = 'Tapped',
  motionKey,
}: {
  image?: { image_url: string } | null;
  presnap?: PresnapClip | Record<string, unknown> | null;
  targets?: TapTarget[] | null;
  options: TapOption[];
  correctIds: number[];
  /** The player's tap(s), for a single answer. */
  chosenIds?: number[];
  /** A whole team: how many tapped each answer (option id -> count). */
  counts?: Partial<Record<number, number>>;
  /** Whose tap it is, in the line under the picture ("Ty tapped", "You tapped"). */
  who?: string;
  motionKey?: string | number;
}) {
  const usable = usableTargets(targets, options.length, !!(image || presnap));
  if (!usable) return null;
  const marks: Partial<Record<number, TapMark>> = {};
  const badges: Partial<Record<number, string>> = {};
  for (const o of options) {
    const right = correctIds.includes(o.id);
    const tapped = chosenIds.includes(o.id) || (counts?.[o.id] ?? 0) > 0;
    if (right) marks[o.id] = 'right';
    else if (tapped) marks[o.id] = 'wrong';
    if (counts && (counts[o.id] ?? 0) > 0) badges[o.id] = String(counts[o.id]);
  }
  const text = (id: number) => options.find((o) => o.id === id)?.option_text ?? '';
  const right = correctIds.map(text).join(', ');
  const missed = chosenIds.filter((id) => !correctIds.includes(id));
  return (
    <figure className={styles.result}>
      <PlayPicture
        image={image}
        presnap={presnap}
        still
        targets={usable}
        options={options}
        marks={marks}
        badges={badges}
        disabled
        motionKey={motionKey}
      />
      <figcaption className={styles.key}>
        {counts ? (
          <>
            <span className={styles.right}>✓ {right}</span>
            <span className={styles.note}> - the number on a spot is how many tapped it</span>
          </>
        ) : missed.length > 0 ? (
          <>
            <span className={styles.wrong}>
              ✕ {who} {missed.map(text).join(', ')}
            </span>
            <span className={styles.right}> · ✓ {right}</span>
          </>
        ) : chosenIds.length > 0 ? (
          <span className={styles.right}>
            ✓ {who} {right}
          </span>
        ) : (
          <span className={styles.right}>✓ {right}</span>
        )}
      </figcaption>
    </figure>
  );
}
