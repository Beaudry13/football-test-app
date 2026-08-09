import { api } from './client';

/** One row of the First Success checklist.
 *
 *  Everything here is decided by the server (see backend
 *  app/services/onboarding.py) - including `route`. The frontend deliberately
 *  does NOT map step ids to destinations: that would be a second copy of the
 *  rules, and the two would drift the first time either side changed. */
export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  /** 'coach' steps are about this coach's own work; 'organization' steps are
   *  shared infrastructure and read as complete for anyone joining a team
   *  that already has them. */
  scope: 'coach' | 'organization';
  action_label: string;
  route: string;
  /** A second, equally valid way to finish the step. Only the roster step has
   *  one today (type them in, or upload a file). */
  secondary_action: { label: string; route: string } | null;
  complete: boolean;
}

/** Suggested next thing AFTER onboarding, never part of it - it depends on a
 *  player picking up a phone, which no coach can do from their desk. Null
 *  until every step is complete. */
export interface OnboardingMilestone {
  id: string;
  title: string;
  description: string;
  action_label: string;
  route: string;
  complete: boolean;
}

export interface OnboardingProgress {
  steps: OnboardingStep[];
  completed_count: number;
  total_count: number;
  complete: boolean;
  next_step_id: string | null;
  dismissed: boolean;
  dismissed_at: string | null;
  milestone: OnboardingMilestone | null;
}

export function getOnboarding(): Promise<OnboardingProgress> {
  return api.get<OnboardingProgress>('/onboarding');
}

/** All three of these return the full progress, so a caller never has to
 *  re-fetch to find out what the state now is. */
export function dismissOnboarding(): Promise<OnboardingProgress> {
  return api.post<OnboardingProgress>('/onboarding/dismiss', {});
}

export function restoreOnboarding(): Promise<OnboardingProgress> {
  return api.delete<OnboardingProgress>('/onboarding/dismiss');
}
