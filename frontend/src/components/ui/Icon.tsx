import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Flame,
  Folder,
  Info,
  Loader2,
  Plus,
  Trash2,
  X,
  type LucideProps,
} from 'lucide-react';

/** Every icon the app uses, named for what it MEANS rather than which
 * glyph draws it - callers write <Icon name="delete" />, never import
 * lucide-react directly. One place to swap the whole icon set later
 * (a different library, custom SVGs, whatever) without touching every
 * page. Replaces the ad-hoc emoji/unicode glyphs (✕ ✓ ← ▾ ▲ 📁 ⧉ 🔥 ℹ ↓ ➜ ＋)
 * that were previously inlined per-file. */
const ICONS = {
  close: X,
  check: Check,
  back: ArrowLeft,
  forward: ArrowRight,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  folder: Folder,
  duplicate: Copy,
  delete: Trash2,
  streak: Flame,
  info: Info,
  download: Download,
  add: Plus,
  spinner: Loader2,
} as const;

export type IconName = keyof typeof ICONS;

interface IconProps extends Omit<LucideProps, 'ref'> {
  name: IconName;
  /** Accessible label. Omit (default) for a purely decorative icon sitting
   * next to its own visible text label - it's then hidden from assistive
   * tech via aria-hidden so it isn't announced twice. */
  label?: string;
}

export function Icon({ name, label, size = 16, strokeWidth = 2, ...rest }: IconProps) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      {...rest}
    />
  );
}
