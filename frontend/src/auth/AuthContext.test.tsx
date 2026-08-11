import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import { ApiError, clearToken, getToken, setToken } from '../api/client';
import * as authApi from '../api/auth';
import type { Coach } from '../api/types';

const mockCoach: Coach = {
  id: 1,
  username: 'coach_smith',
  email: 'coach@example.com',
  organization: 'Wildcats',
  organization_id: 1,
  role: 'admin',
  is_platform_owner: false,
  created_at: '2026-01-01T00:00:00Z',
};

function renderAuth() {
  return renderHook(() => useAuth(), { wrapper: AuthProvider });
}

describe('AuthProvider', () => {
  beforeEach(() => {
    clearToken();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearToken();
  });

  it('starts with no coach and finishes loading immediately when there is no stored token', async () => {
    const { result } = renderAuth();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.coach).toBeNull();
  });

  it('loads the coach from a stored token on mount', async () => {
    setToken('existing-token');
    vi.spyOn(authApi, 'me').mockResolvedValue(mockCoach);

    const { result } = renderAuth();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.coach).toEqual(mockCoach);
  });

  it('clears the token when the server rejects it as invalid (401)', async () => {
    setToken('stale-token');
    vi.spyOn(authApi, 'me').mockRejectedValue(new ApiError('Coach account no longer exists', 401));

    const { result } = renderAuth();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.coach).toBeNull();
    expect(getToken()).toBeNull();
  });

  it('keeps the token when the failure is a network error, not a rejection', async () => {
    // Regression test: this used to log the coach out just because the
    // backend was briefly unreachable, forcing an unnecessary re-login.
    setToken('still-valid-token');
    vi.spyOn(authApi, 'me').mockRejectedValue(
      new ApiError('Could not reach the server. Check your connection and try again.', 0),
    );

    const { result } = renderAuth();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.coach).toBeNull(); // can't confirm identity, so not "logged in" this render
    expect(getToken()).toBe('still-valid-token'); // but the session itself wasn't destroyed
  });

  it('login() stores the token and sets the coach', async () => {
    vi.spyOn(authApi, 'login').mockResolvedValue({ coach: mockCoach, access_token: 'new-token' });
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.login('coach@example.com', 'password123');
    });

    expect(result.current.coach).toEqual(mockCoach);
    expect(getToken()).toBe('new-token');
  });

  it('register() stores the token and sets the coach', async () => {
    vi.spyOn(authApi, 'register').mockResolvedValue({ coach: mockCoach, access_token: 'reg-token' });
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.register({
        username: 'coach_smith',
        email: 'coach@example.com',
        password: 'password123',
        organization: 'Wildcats',
      });
    });

    expect(result.current.coach).toEqual(mockCoach);
    expect(getToken()).toBe('reg-token');
  });

  it('logout() clears the token and the coach', async () => {
    vi.spyOn(authApi, 'login').mockResolvedValue({ coach: mockCoach, access_token: 'a-token' });
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => {
      await result.current.login('coach@example.com', 'password123');
    });

    act(() => result.current.logout());

    expect(result.current.coach).toBeNull();
    expect(getToken()).toBeNull();
  });

  it('login() propagates a failure without storing a token', async () => {
    vi.spyOn(authApi, 'login').mockRejectedValue(new ApiError('Invalid email or password', 401));
    const { result } = renderAuth();
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await expect(
      act(async () => {
        await result.current.login('coach@example.com', 'wrong-password');
      }),
    ).rejects.toThrow('Invalid email or password');

    expect(result.current.coach).toBeNull();
    expect(getToken()).toBeNull();
  });
});
