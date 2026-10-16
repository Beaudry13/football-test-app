import { lazy, Suspense, type ReactNode } from 'react';
import { resolveMediaUrl } from '../../api/client';
import type { PresnapClip } from '../../motion-lab/presnap';
import { TapOverlay, type TapOption } from './TapOverlay';
import type { TapTarget } from './tapTargets';
import styles from './PlayPicture.module.css';

// The moving play is Motion Lab's renderer - loaded only for a question that has one.
const PresnapPicture = lazy(() => import('../../motion-lab/PresnapPicture'));

/**
 * THE FOOTBALL PICTURE OF A QUESTION - one component for every place a player
 * (or a coach teaching him) meets it: a normal Quiz, a Rep, Review Missed,
 * Teach. The play moving to the decision moment when it has motion, else the
 * still; with `targets`, the answers in the picture (TapOverlay).
 */
export function PlayPicture({
  image,
  presnap,
  targets,
  options,
  onTap,
  chosen,
  tone,
  disabled,
  onMove,
  still = false,
  autoplay = true,
  onMotionDone,
  pictureClassName,
  className,
  alt = 'The play',
  motionKey,
  children,
}: {
  image?: { image_url: string } | null;
  presnap?: PresnapClip | Record<string, unknown> | null;
  /** Usable targets only (tapTargets.usableTargets) - one per option. */
  targets?: TapTarget[] | null;
  options?: TapOption[];
  onTap?: (optionId: number) => void;
  chosen?: number[];
  tone?: 'right' | 'wrong' | null;
  disabled?: boolean;
  onMove?: (index: number, at: { x: number; y: number }) => void;
  /** A review or a checked question: the frozen moment, no motion. */
  still?: boolean;
  /** False on a screen of several questions: tap to play. */
  autoplay?: boolean;
  onMotionDone?: () => void;
  /** The still's own class (the moving picture draws its own). */
  pictureClassName?: string;
  className?: string;
  alt?: string;
  /** Restart the motion when this changes (a new question). */
  motionKey?: string | number;
  children?: ReactNode;
}) {
  const overlay =
    targets && options && (onTap || onMove || disabled) ? (
      <TapOverlay targets={targets} options={options} onTap={onTap} chosen={chosen} tone={tone} disabled={disabled} onMove={onMove} />
    ) : null;
  const stillImage = image ? (
    <img className={pictureClassName ?? styles.picture} src={resolveMediaUrl(image.image_url)} alt={alt} />
  ) : null;

  if (presnap) {
    return (
      <Suspense fallback={stillImage}>
        <PresnapPicture
          key={motionKey}
          clip={presnap as unknown as PresnapClip}
          still={still}
          autoplay={autoplay}
          onDone={onMotionDone}
          className={className}
        >
          {overlay}
          {children}
        </PresnapPicture>
      </Suspense>
    );
  }
  if (!stillImage) return null;
  return (
    <div className={className ? `${styles.wrap} ${className}` : styles.wrap}>
      {stillImage}
      {overlay}
      {children}
    </div>
  );
}
