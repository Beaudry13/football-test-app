import { api } from './client';
import type {
  AccessRequestRow,
  CoachInvite,
  CoachInviteCreated,
  CoachInviteRevealed,
  MergePreview,
  MergeResult,
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
 * Read-only by design, with the single deliberate exception of the two merge
 * calls below. Access requests in particular are list-only: no approve, deny,
 * delete or invite call exists, because deciding is a person writing an
 * email. */

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

export interface MergeRequest {
  source_organization_id: number;
  destination_organization_id: number;
  coach_roles?: Record<string, 'ADMIN' | 'MEMBER'>;
}

/** Writes nothing. A POST only because it carries a body. */
/** People who asked for access, newest first. Read-only: there is no
 *  corresponding approve, deny or delete call, by design. */
export function listAccessRequests(): Promise<{ access_requests: AccessRequestRow[] }> {
  return api.get<{ access_requests: AccessRequestRow[] }>('/owner/access-requests');
}

/** Invitations to create a Peira account, newest first. No token is returned
 *  here - see CoachInvite. */
export function listCoachInvites(): Promise<{ coach_invites: CoachInvite[] }> {
  return api.get<{ coach_invites: CoachInvite[] }>('/owner/coach-invites');
}

/** Issue one. THE ONLY MOMENT the token exists - the caller must show it
 *  immediately, because no later request can return it. */
export function createCoachInvite(input: {
  label?: string | null;
  expires_in_days?: number;
}): Promise<CoachInviteCreated> {
  return api.post<CoachInviteCreated>('/owner/coach-invites', input);
}

/** One pending invite WITH its code, so the owner can reshare what they
 *  already sent. `token` is absent when it cannot be recovered - a legacy
 *  invite, a missing key, or anything no longer pending. */
export function revealCoachInvite(id: number): Promise<CoachInviteRevealed> {
  return api.get<CoachInviteRevealed>(`/owner/coach-invites/${id}`);
}

/** Give an invite whose code is unrecoverable a working one, keeping the row.
 *  THE PREVIOUS CODE STOPS WORKING - the caller must say so first. */
export function replaceCoachInvite(id: number): Promise<CoachInviteCreated> {
  return api.post<CoachInviteCreated>(`/owner/coach-invites/${id}/replace`, {});
}

export function revokeCoachInvite(id: number): Promise<CoachInvite> {
  return api.post<CoachInvite>(`/owner/coach-invites/${id}/revoke`, {});
}

export function previewMerge(body: MergeRequest): Promise<MergePreview> {
  return api.post<MergePreview>('/owner/merges/preview', body);
}

/** The one destructive owner operation. `fingerprint` comes from a preview -
 *  the server refuses if either organization changed since. */
export function executeMerge(
  body: MergeRequest & {
    fingerprint: string;
    acknowledge_collisions: boolean;
    acknowledge_duplicate_players: boolean;
  },
): Promise<MergeResult> {
  return api.post<MergeResult>('/owner/merges/execute', body);
}
