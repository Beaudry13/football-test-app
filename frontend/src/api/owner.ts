import { api } from './client';
import type {
  OwnerCoachRow,
  OwnerOrganizationDetail,
  OwnerOrganizationRow,
  PlatformOverview,
} from './types';

/** Peira Owner Dashboard client.
 *
 * A level above organizations: these endpoints report platform-wide adoption
 * and usage, and they are reachable only by a coach with is_platform_owner.
 * A non-owner receives 404 rather than 403, so the app must not treat a
 * failure here as "forbidden" and show a permissions message that confirms
 * the area exists.
 *
 * Read-only by design. There is deliberately no mutating call in this file. */

export function getPlatformOverview(): Promise<PlatformOverview> {
  return api.get<PlatformOverview>('/owner/overview');
}

export interface OwnerOrganizationQuery {
  search?: string;
  /** 'empty' returns only organizations with no players, quizzes or attempts
   *  - how leftover probe organizations are found, by their data rather than
   *  by their name. */
  filter?: 'empty';
}

export function listOwnerOrganizations(
  query: OwnerOrganizationQuery = {},
): Promise<{ organizations: OwnerOrganizationRow[]; count: number }> {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.filter) params.set('filter', query.filter);
  const suffix = params.toString() ? `?${params}` : '';
  return api.get<{ organizations: OwnerOrganizationRow[]; count: number }>(
    `/owner/organizations${suffix}`,
  );
}

export function getOwnerOrganization(id: number): Promise<OwnerOrganizationDetail> {
  return api.get<OwnerOrganizationDetail>(`/owner/organizations/${id}`);
}

export interface OwnerCoachQuery {
  search?: string;
  /** Both values are about ATTRIBUTABLE activity only - a coach with none is
   *  unknown rather than inactive. See the type's own note. */
  filter?: 'with_activity' | 'no_activity';
}

export function listOwnerCoaches(
  query: OwnerCoachQuery = {},
): Promise<{ coaches: OwnerCoachRow[]; count: number }> {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.filter) params.set('filter', query.filter);
  const suffix = params.toString() ? `?${params}` : '';
  return api.get<{ coaches: OwnerCoachRow[]; count: number }>(`/owner/coaches${suffix}`);
}
