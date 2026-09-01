import { useState } from 'react';
import styles from './ClipPlayer.module.css';

/** A recorded clip, rendered the way a GIF reads.
 *
 * The four attributes are not decoration and none is optional:
 *
 *   autoplay     starts without a tap
 *   loop         repeats forever
 *   muted        REQUIRED, or autoplay is blocked on every browser
 *   playsinline  REQUIRED, or iOS takes the video fullscreen mid-quiz
 *
 * Dropping `muted` or `playsinline` breaks playback on exactly the devices
 * players use, and would never fail a test that only checked a <video>
 * rendered - which is why there is a test asserting all four.
 *
 * A CLIP THAT WILL NOT PLAY FALLS BACK TO ITS POSTER, not to a black box. The
 * still frame is real football material and is worth showing on its own; the
 * caption says the motion is missing rather than letting a coach or player
 * conclude the question is broken.
 */
export function ClipPlayer({
  url,
  posterUrl,
  className,
  ariaLabel,
}: {
  url: string;
  posterUrl?: string | null;
  className?: string;
  ariaLabel?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div>
        {posterUrl ? (
          /* A REAL ALT, not an empty one. Beside a working video the poster is
             decorative - the video carries the meaning. Here it is the only
             thing conveying the football, so it has to describe itself. */
          <img
            className={styles.fallback}
            src={posterUrl}
            alt={ariaLabel ?? 'Still frame from the recorded clip'}
          />
        ) : null}
        <p className={styles.fallbackNote}>
          This clip could not play here{posterUrl ? ' - showing a still frame.' : '.'}
        </p>
      </div>
    );
  }

  return (
    <video
      className={`${styles.clip} ${className ?? ''}`}
      src={url}
      poster={posterUrl ?? undefined}
      autoPlay
      loop
      muted
      playsInline
      // No controls: a fifteen-second silent loop has nothing to control, and
      // a scrubber would invite a player to treat it as a video rather than
      // as the material the question is about.
      controls={false}
      aria-label={ariaLabel}
      onError={() => setFailed(true)}
    />
  );
}

/** The still frame alone, for surfaces where motion would be noise.
 *
 * A coach's question list can hold twenty questions; twenty simultaneously
 * looping videos is real decoding work for no benefit, since the list is
 * scanned rather than watched. */
export function ClipThumbnail({
  posterUrl,
  className,
  alt = '',
}: {
  posterUrl: string | null | undefined;
  className?: string;
  alt?: string;
}) {
  if (!posterUrl) return null;
  return <img className={className} src={posterUrl} alt={alt} loading="lazy" />;
}
