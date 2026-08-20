import { api } from './client';
import type {
  CoachRole,
  Folder,
  Organization,
  OrganizationInvite,
  OrganizationMember,
  Quiz,
} from './types';

export function getOrganization(): Promise<Organization> {
  return api.get<Organization>('/organizations');
}

export function renameOrganization(input: { name: string }): Promise<Organization> {
  return api.patch<Organization>('/organizations', input);
}

/** Asks for one of your staff to be let into YOUR organization.
 *
 * Creates no invite and grants nothing - a person reviews it and, if they
 * approve, Peira mints the single-use invitation. The organization comes from
 * the authenticated coach, so there is deliberately nothing here to send.
 */
export function requestStaffInvite(input: {
  name: string;
  email: string;
}): Promise<{ message: string }> {
  return api.post<{ message: string }>('/organizations/staff-invite-requests', input);
}

export function listInvites(): Promise<OrganizationInvite[]> {
  return api.get<OrganizationInvite[]>('/organizations/invites');
}

/** The response is the only place the invite code appears - show it to the
 * admin immediately, since it can't be read back later. */
export function createInvite(): Promise<OrganizationInvite> {
  return api.post<OrganizationInvite>('/organizations/invites');
}

export function revokeInvite(inviteId: number): Promise<void> {
  return api.delete<void>(`/organizations/invites/${inviteId}`);
}

export function updateMemberRole(coachId: number, role: CoachRole): Promise<OrganizationMember> {
  return api.patch<OrganizationMember>(`/organizations/members/${coachId}`, { role });
}

export function removeMember(coachId: number): Promise<void> {
  return api.delete<void>(`/organizations/members/${coachId}`);
}

/** A quiz as Admin View sees it: the normal payload plus who owns it. */
export interface OrganizationQuiz extends Quiz {
  owner: { id: number; username: string } | null;
  /** True when nobody owns it. Such a quiz is in NO coach's Coach View, so
   *  Admin View is the only place it can be found and reassigned. */
  is_unassigned: boolean;
}

/** Everything Admin View's tree needs, in ONE response.
 *
 *  Folders come back with the quizzes so the tree can be built client-side
 *  and expanding a branch costs no request. Filtering and search also run
 *  locally against this payload - the server still accepts coachId/search for
 *  an organization large enough to want narrowing, but the tree does not use
 *  them, because a round-trip per keystroke is worse UX than filtering a few
 *  hundred rows in memory. */
export interface OrganizationTree {
  folders: Folder[];
  quizzes: OrganizationQuiz[];
}

export function listOrganizationQuizzes(params: {
  coachId?: number | 'unassigned' | null;
  search?: string;
} = {}): Promise<OrganizationTree> {
  const query = new URLSearchParams();
  if (params.coachId !== undefined && params.coachId !== null) {
    query.set('coach_id', String(params.coachId));
  }
  if (params.search) query.set('q', params.search);
  const suffix = query.toString() ? `?${query}` : '';
  return api.get<OrganizationTree>(`/organizations/quizzes${suffix}`);
}

/** Explicit ownership transfer. Never happens as a side effect of anything
 *  else - ownership decides whose Coach View a quiz appears in. */
export function transferQuizOwner(quizId: number, coachId: number): Promise<OrganizationQuiz> {
  return api.patch<OrganizationQuiz>(`/organizations/quizzes/${quizId}/owner`, {
    coach_id: coachId,
  });
}
