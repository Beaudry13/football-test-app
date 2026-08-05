import peiraMark from '../../assets/peira-mark.png';

/** The real Peira mark (hammered-gold "P" letterform, matted to a
 * transparent background) - see frontend/src/assets/peira-mark.png. It's a
 * photorealistic textured image, not something a hand-drawn SVG could
 * faithfully reproduce, so it's rendered as-is rather than redrawn; only
 * the "PEIRA" wordmark stays real text (Playfair Display, same as the rest
 * of the site), so its color/letter-spacing stays tunable in CSS and it stays
 * screen-reader-friendly. The mark's own gold tone reads fine on both the
 * dark coach theme and the light player theme, so unlike before it doesn't
 * need a separate per-variant recolor - `variant` now only affects the
 * wordmark text color. */

const WORDMARK_COLOR = {
  dark: '#f3eee2',
  light: '#2a2416',
} as const;

export interface PeiraLogoProps {
  variant?: keyof typeof WORDMARK_COLOR;
  /** Renders just the mark, no "PEIRA" text - for compact placements (nav
   * bars, small headers) where the full lockup won't stay legible. */
  markOnly?: boolean;
  size?: number;
  className?: string;
}

export function PeiraLogo({ variant = 'dark', markOnly = false, size = 40, className }: PeiraLogoProps) {
  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.4, lineHeight: 1 }}
    >
      <img src={peiraMark} alt={markOnly ? 'Peira' : ''} height={size} style={{ width: 'auto' }} />
      {!markOnly && (
        <span
          style={{
            fontFamily: 'var(--font-heading)',
            fontWeight: 700,
            fontSize: size * 0.6,
            letterSpacing: '0.12em',
            color: WORDMARK_COLOR[variant],
          }}
        >
          PEIRA
        </span>
      )}
    </span>
  );
}
