import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  login as apiLogin,
  registerWithInvite as apiRegisterWithInvite,
  registerWithBetaInvite as apiRegisterWithBetaInvite,
  me as apiMe,
} from '../api/auth';
import { ApiError, clearToken, getToken, setToken } from '../api/client';
import type { Coach } from '../api/types';

interface AuthContextValue {
  coach: Coach | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  registerWithInvite: (input: {
    username: string;
    email: string;
    password: string;
    invite_code: string;
  }) => Promise<void>;
  registerWithBetaInvite: (input: {
    username: string;
    email: string;
    password: string;
    organization: string;
    invite_code: string;
  }) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [coach, setCoach] = useState<Coach | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setIsLoading(false);
      return;
    }
    apiMe()
      .then(setCoach)
      .catch((err: unknown) => {
        // Only clear a token the server actually rejected. A network error
        // (backend unreachable, offline) doesn't mean the session is
        // invalid - clearing it here would silently log the coach out just
        // because the server was briefly unreachable, forcing an
        // unnecessary re-login once it's back.
        if (err instanceof ApiError && err.status === 401) {
          clearToken();
        }
      })
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await apiLogin({ email, password });
    setToken(result.access_token);
    setCoach(result.coach);
  }, []);

  const registerWithInvite = useCallback(
    async (input: { username: string; email: string; password: string; invite_code: string }) => {
      const result = await apiRegisterWithInvite(input);
      setToken(result.access_token);
      setCoach(result.coach);
    },
    [],
  );

  const registerWithBetaInvite = useCallback(
    async (input: {
      username: string;
      email: string;
      password: string;
      organization: string;
      invite_code: string;
    }) => {
      const result = await apiRegisterWithBetaInvite(input);
      setToken(result.access_token);
      setCoach(result.coach);
    },
    [],
  );

  const logout = useCallback(() => {
    clearToken();
    setCoach(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        coach,
        isLoading,
        login,
        registerWithInvite,
        registerWithBetaInvite,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
