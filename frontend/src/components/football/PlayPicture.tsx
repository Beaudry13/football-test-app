import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { resolveMediaUrl } from '../../api/client';
import type { PresnapClip } from '../../motion-lab/presnap';
import { TapOverlay, type TapMark, type TapOption } from './TapOverlay';
import type { TapTarget } from './tapTargets';
import styles from './PlayPicture.module.css';

// The moving play is Motion Lab's renderer - loaded only for a question that has one.
const PresnapPicture = lazy(() => import('../../motion-lab/PresnapPicture'));

/** A still drawn here rather than uploaded (Make rep, before the picture exists). */
export interface DrawnStill {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

function Drawn({ still, className }: { still: DrawnStill; className: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    still.draw(ctx);
  }, [still]);
  return <canvas ref={canvas} className={className} width={still.width} height={still.height} role="img" aria-label="The play" />;
}

/**
 * THE FOOTBALL PICTURE OF A QUESTION - one component for every place a player
 * (or a coach teaching him) meets it: a normal Quiz, a Rep, Review Missed,
 * Teach. The play moving to the decision moment when it has motion, else the
 * still; with `targets`, the answers in the picture (TapOverlay).
 */
export function PlayPicture({
  image,
  presnap,
  drawn,
  targets,
  options,
  onTap,
  chosen,
  tone,
  disabled,
  onMove,
  marks,
  badges,
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
  /** Authoring only: the still drawn here (used when there is no motion). */
  drawn?: DrawnStill;
  /** Usable targets only (tapTargets.usableTargets) - one per option. */
  targets?: TapTarget[] | null;
  options?: TapOption[];
  onTap?: (optionId: number) => void;
  chosen?: number[];
  tone?: 'right' | 'wrong' | null;
  disabled?: boolean;
  onMove?: (index: number, at: { x: number; y: number }) => void;
  /** A result: each answer marked on its own (TapOverlay). */
  marks?: Partial<Record<number, TapMark>>;
  badges?: Partial<Record<number, string>>;
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
      <TapOverlay
        targets={targets}
        options={options}
        onTap={onTap}
        chosen={chosen}
        tone={tone}
        disabled={disabled}
        onMove={onMove}
        marks={marks}
        badges={badges}
      />
    ) : null;
  const stillImage = drawn ? (
    <Drawn still={drawn} className={pictureClassName ?? styles.picture} />
  ) : image ? (
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
