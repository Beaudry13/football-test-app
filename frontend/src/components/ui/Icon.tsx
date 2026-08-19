import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  Eraser,
  Flame,
  Folder,
  Hand,
  Info,
  Loader2,
  Maximize,
  Pencil,
  Plus,
  Redo2,
  Trash2,
  Undo2,
  X,
  type LucideProps,
  FolderOpen,
  FileText, MoreHorizontal } from 'lucide-react';

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
  chevronRight: ChevronRight,
  chevronUp: ChevronUp,
  folder: Folder,
  // Admin View's tree distinguishes an open branch from a closed one with
  // the icon as well as the chevron - two signals for one state, because the
  // chevron alone is small and easy to miss when scanning a deep tree.
  folderOpen: FolderOpen,
  quiz: FileText,
  duplicate: Copy,
  delete: Trash2,
  streak: Flame,
  info: Info,
  download: Download,
  add: Plus,
  // The quiet affordance for row actions - see components/ui/MenuButton.
  more: MoreHorizontal,
  spinner: Loader2,
  // Drawing board tools (see components/drawing/). `eraser` is deliberately
  // separate from `delete`: one removes a stroke from a drawing, the other
  // destroys a record, and they must never look alike.
  pen: Pencil,
  pan: Hand,
  eraser: Eraser,
  undo: Undo2,
  redo: Redo2,
  fitView: Maximize,
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
