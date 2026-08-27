import { api } from './client';
import type { Coach } from './types';

export interface AuthResponse {
  coach: Coach;
  access_token: string;
}

/* OPEN REGISTRATION IS GONE. `POST /auth/register` was removed when Peira went
 * invite-only - a coach is created either by spending a platform invitation
 * (registerWithBetaInvite) or by accepting one into an existing organization
 * (registerWithInvite). Nothing here should call a route the server no longer
 * serves. */

/** Joins an existing organization. The org comes from the invite, so there's
 * no organization name to supply. */
export function registerWithInvite(input: {
  username: string;
  email: string;
  password: string;
  invite_code: string;
}): Promise<AuthResponse> {
  return api.post<AuthResponse>('/auth/register-with-invite', input, { auth: false });
}

/** Redeems a Peira invite: creates a coach AND the program they will run,
 * with the coach as its admin. Distinct from `registerWithInvite` above, which
 * adds a coach to an organization that already exists - which is why this one
 * asks for a program name and that one does not. */
export function registerWithBetaInvite(input: {
  username: string;
  email: string;
  password: string;
  organization: string;
  invite_code: string;
}): Promise<AuthResponse> {
  return api.post<AuthResponse>('/auth/register-with-beta-invite', input, { auth: false });
}

/** Unauthenticated peek at an invite, so the join page can name the
 * organization before asking for a password. */
export function previewInvite(inviteCode: string): Promise<{ organization_name: string }> {
  return api.get<{ organization_name: string }>(
    `/auth/invites/${encodeURIComponent(inviteCode)}`,
    { auth: false },
  );
}

/** Asks to be let into the beta. Grants nothing - it records that somebody
 * put their hand up, and an invite is still issued by hand.
 *
 * THE ANSWER IS THE SAME WHATEVER HAPPENED. A first request, a repeat request
 * and an address that already has an account all come back identically, so
 * this form cannot be used to test whether a particular coach uses Peira.
 * Callers must not try to distinguish them. */
export function requestAccess(input: {
  name: string;
  email: string;
  team?: string;
}): Promise<{ message: string }> {
  return api.post<{ message: string }>('/auth/request-access', input, { auth: false });
}

export function login(input: { email: string; password: string }): Promise<AuthResponse> {
  return api.post<AuthResponse>('/auth/login', input, { auth: false });
}

export function me(): Promise<Coach> {
  return api.get<Coach>('/auth/me');
}
