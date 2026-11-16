import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { ApiError, request, type User } from './api';
import { loadToken, saveToken } from './storage';

interface AuthState {
  /** False until the stored session has been read. */
  ready: boolean;
  token: string | null;
  signIn: (mode: 'login' | 'register', username: string, password: string) => Promise<void>;
  signOut: () => void;
  /** Authenticated request; signs out when the session is no longer valid. */
  call: <T>(path: string, options?: { method?: string; body?: unknown }) => Promise<T>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    loadToken().then((stored) => {
      setToken(stored);
      setReady(true);
    });
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    saveToken(null);
  }, []);

  const signIn = useCallback(async (mode: 'login' | 'register', username: string, password: string) => {
    const res = await request<{ token: string; user: User }>(`/auth/${mode}`, { body: { username, password } });
    await saveToken(res.token);
    setToken(res.token);
  }, []);

  const call = useCallback(
    async <T,>(path: string, options: { method?: string; body?: unknown } = {}) => {
      try {
        return await request<T>(path, { ...options, token });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401 && err.code === 'unauthorized') signOut();
        throw err;
      }
    },
    [token, signOut],
  );

  const value = useMemo(() => ({ ready, token, signIn, signOut, call }), [ready, token, signIn, signOut, call]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
