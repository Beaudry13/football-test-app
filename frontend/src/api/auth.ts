import { api } from './client';
import type { Coach } from './types';

export interface AuthResponse {
  coach: Coach;
  access_token: string;
}

export function register(input: {
  username: string;
  email: string;
  password: string;
  organization: string;
}): Promise<AuthResponse> {
  return api.post<AuthResponse>('/auth/register', input, { auth: false });
}

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

export function login(input: { email: string; password: string }): Promise<AuthResponse> {
  return api.post<AuthResponse>('/auth/login', input, { auth: false });
}

export function me(): Promise<Coach> {
  return api.get<Coach>('/auth/me');
}
