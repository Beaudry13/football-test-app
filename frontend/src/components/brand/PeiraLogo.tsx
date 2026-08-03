/** The Peira mark: a rotated-45deg diamond outline with a Cinzel-weight "Π"
 * glyph counter-rotated back upright inside it - matches the diamond+Π
 * concept from the provided design handoff exactly (not a guess at the
 * separately-provided ornate wordmark image, which has hand-drawn
 * flourishes no vector recreation could match faithfully; this is a
 * deliberately simpler, cleaner mark in the same spirit, sized to stay
 * legible down to favicon size).
 *
 * `variant` swaps the mark's stroke/text color for dark (gold, for the
 * black coach header) vs. light (deep gold/ink, for light-background
 * contexts - e.g. the player-facing header) placements - same shape, just
 * recolored, per the resolved rebrand decision. */

const COLORS = {
  dark: { mark: '#c9a24b', wordmark: '#f3eee2' },
  light: { mark: '#a6822f', wordmark: '#2a2416' },
} as const;

export interface PeiraLogoProps {
  variant?: keyof typeof COLORS;
  /** Renders just the diamond+Π mark, no "PEIRA" text - for compact
   * placements (nav bars, small headers) where the full lockup won't stay
   * legible. */
  markOnly?: boolean;
  size?: number;
  className?: string;
}

export function PeiraLogo({ variant = 'dark', markOnly = false, size = 40, className }: PeiraLogoProps) {
  const colors = COLORS[variant];

  return (
    <span
      className={className}
      style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.4, lineHeight: 1 }}
    >
      <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" focusable="false">
        <g transform="rotate(45 20 20)">
          <rect x="6" y="6" width="28" height="28" fill="none" stroke={colors.mark} strokeWidth="1.5" />
          <text
            x="20"
            y="21"
            transform="rotate(-45 20 20)"
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily="Cinzel, serif"
            fontWeight="700"
            fontSize="15"
            fill={colors.mark}
          >
            &#928;
          </text>
        </g>
      </svg>
      {!markOnly && (
        <span
          style={{
            fontFamily: "'Cinzel', serif",
            fontWeight: 700,
            fontSize: size * 0.6,
            letterSpacing: '0.12em',
            color: colors.wordmark,
          }}
        >
          PEIRA
        </span>
      )}
    </span>
  );
}
