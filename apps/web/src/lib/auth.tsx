import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  fetchCurrentUser,
  googleLoginRequest,
  loginDemo as loginDemoRequest,
  loginRequest,
  logout as logoutRequest,
  signupRequest,
  type UserRecord,
} from "./api";
import { promoteAllPending } from "./sync";

export type AuthStatus = "loading" | "authenticated" | "guest";

interface AuthContextValue {
  user: UserRecord | null;
  status: AuthStatus;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<UserRecord>;
  signup: (name: string, email: string, password: string) => Promise<UserRecord>;
  loginWithGoogle: (credential: string) => Promise<UserRecord>;
  loginDemo: () => Promise<UserRecord>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserRecord | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  // Validate any stored session on boot. Never auto-creates one (guest stays guest).
  useEffect(() => {
    let active = true;
    fetchCurrentUser()
      .then((u) => {
        if (!active) return;
        setUser(u);
        setStatus("authenticated");
      })
      .catch(() => {
        if (!active) return;
        setUser(null);
        setStatus("guest");
      });
    return () => {
      active = false;
    };
  }, []);

  // After any successful sign-in, claim guest local drafts into the account (idempotent).
  const adopt = useCallback((u: UserRecord) => {
    setUser(u);
    setStatus("authenticated");
    void promoteAllPending();
    return u;
  }, []);

  const login = useCallback(
    async (email: string, password: string) => adopt(await loginRequest(email, password)),
    [adopt]
  );
  const signup = useCallback(
    async (name: string, email: string, password: string) => adopt(await signupRequest(name, email, password)),
    [adopt]
  );
  const loginWithGoogle = useCallback(async (credential: string) => adopt(await googleLoginRequest(credential)), [adopt]);
  const loginDemo = useCallback(async () => adopt(await loginDemoRequest()), [adopt]);

  const logout = useCallback(() => {
    logoutRequest();
    setUser(null);
    setStatus("guest");
  }, []);

  const refresh = useCallback(async () => {
    try {
      const u = await fetchCurrentUser();
      setUser(u);
      setStatus("authenticated");
    } catch {
      setUser(null);
      setStatus("guest");
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      isAuthenticated: status === "authenticated",
      login,
      signup,
      loginWithGoogle,
      loginDemo,
      logout,
      refresh,
    }),
    [user, status, login, signup, loginWithGoogle, loginDemo, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
