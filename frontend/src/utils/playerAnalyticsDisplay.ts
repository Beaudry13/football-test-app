import type { ReviewStatus, TrendDirection } from '../api/types';

/** Shared vocabulary for Player Progress Analytics status labels - kept in
 * one place so the Player Profile page and the organization Player
 * Progress page never drift apart on wording. Deliberately avoids shaming
 * language (no "Bad"/"Failing"/"Weak") per the product brief - "Needs
 * Review" and "Improving"/"Declining" read as informational, not punitive. */

export function reviewStatusLabel(status: ReviewStatus): string {
  switch (status) {
    case 'strong':
      return 'Strong';
    case 'needs_review':
      return 'Needs Review';
    case 'pending_grading':
      return 'Pending Grading';
    default:
      return 'Incomplete';
  }
}

/** Badge modifier class name (without the module - caller combines with its
 * own `nb.badge`/`nb.badgeX`). "strong" -> success (green), "needs_review"
 * -> warning (amber, not red - informational, not alarming), "pending
 * grading"/"incomplete" -> neutral. */
export function reviewStatusBadgeVariant(status: ReviewStatus): 'badgeSuccess' | 'badgeWarning' | 'badgeNeutral' {
  switch (status) {
    case 'strong':
      return 'badgeSuccess';
    case 'needs_review':
      return 'badgeWarning';
    default:
      return 'badgeNeutral';
  }
}

export function trendLabel(direction: TrendDirection): string {
  switch (direction) {
    case 'improving':
      return 'Improving';
    case 'declining':
      return 'Declining';
    case 'flat':
      return 'Flat';
    default:
      return 'No Recent Activity';
  }
}

/** Plain-text directional glyph, never the only signal - always pair with
 * trendLabel's text so meaning doesn't depend on interpreting an arrow or a
 * color alone. */
export function trendArrow(direction: TrendDirection): string {
  switch (direction) {
    case 'improving':
      return '↑';
    case 'declining':
      return '↓';
    case 'flat':
      return '→';
    default:
      return '';
  }
}

export function formatScore(percent: number | null): string {
  return percent !== null ? `${percent}%` : '—';
}

export function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : '—';
}
