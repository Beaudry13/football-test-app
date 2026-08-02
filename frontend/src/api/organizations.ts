import { api } from './client';
import type { CoachRole, Organization, OrganizationInvite, OrganizationMember } from './types';

export function getOrganization(): Promise<Organization> {
  return api.get<Organization>('/organizations');
}

export function renameOrganization(input: { name: string }): Promise<Organization> {
  return api.patch<Organization>('/organizations', input);
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
