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

export function login(input: { email: string; password: string }): Promise<AuthResponse> {
  return api.post<AuthResponse>('/auth/login', input, { auth: false });
}

export function me(): Promise<Coach> {
  return api.get<Coach>('/auth/me');
}
