import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatScore,
  reviewStatusBadgeVariant,
  reviewStatusLabel,
  trendArrow,
  trendLabel,
} from './playerAnalyticsDisplay';

describe('playerAnalyticsDisplay', () => {
  it('labels every review status without shaming language', () => {
    expect(reviewStatusLabel('strong')).toBe('Strong');
    expect(reviewStatusLabel('needs_review')).toBe('Needs Review');
    expect(reviewStatusLabel('pending_grading')).toBe('Pending Grading');
    expect(reviewStatusLabel(null)).toBe('Incomplete');
  });

  it('maps review status to a badge variant, never a raw color meaning', () => {
    expect(reviewStatusBadgeVariant('strong')).toBe('badgeSuccess');
    expect(reviewStatusBadgeVariant('needs_review')).toBe('badgeWarning');
    expect(reviewStatusBadgeVariant('pending_grading')).toBe('badgeNeutral');
    expect(reviewStatusBadgeVariant(null)).toBe('badgeNeutral');
  });

  it('labels every trend direction, defaulting to No Recent Activity', () => {
    expect(trendLabel('improving')).toBe('Improving');
    expect(trendLabel('declining')).toBe('Declining');
    expect(trendLabel('flat')).toBe('Flat');
    expect(trendLabel(null)).toBe('No Recent Activity');
  });

  it('pairs each trend direction with a distinct arrow, never color alone', () => {
    expect(trendArrow('improving')).toBe('↑');
    expect(trendArrow('declining')).toBe('↓');
    expect(trendArrow('flat')).toBe('→');
    expect(trendArrow(null)).toBe('');
  });

  it('formats a null score as an em dash, never 0%', () => {
    expect(formatScore(85)).toBe('85%');
    expect(formatScore(0)).toBe('0%');
    expect(formatScore(null)).toBe('—');
  });

  it('formats a null date as an em dash', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('2026-01-05T00:00:00Z')).not.toBe('—');
  });
});
