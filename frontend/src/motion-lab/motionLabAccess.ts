/**
 * WHO MAY USE MOTION LAB IN THE UI - platform owners only, during the P2 pilot.
 *
 * The frontend mirror of `require_motion_lab_coach` (backend/app/utils/auth.py),
 * which is the real boundary. One predicate, used by the route gate and the
 * navigation link, so opening Motion Lab to coaches later is one change here
 * plus the backend check.
 */
export function mayUseMotionLab(coach: { is_platform_owner: boolean } | null | undefined): boolean {
  return !!coach?.is_platform_owner
}
