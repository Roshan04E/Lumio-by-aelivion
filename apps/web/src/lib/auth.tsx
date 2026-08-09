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
  //
  // AWAITED (was `void promoteAllPending()`, fire-and-forget). Measured 2026-08-09: on a normal
  // client-side sign-in the unawaited version usually finished before the caller's navigate() /
  // Dashboard's one-shot listProjects() fetch anyway, so it rarely showed — but a full page reload
  // fired the instant sign-in completed reliably ABORTED the in-flight promotion (`syncStatus` landed
  // on "failed", no `serverId`), and Dashboard's project list is a one-shot fetch with no subscription
  // to sync state, so a promotion racing behind navigation could land after the list already rendered.
  // Awaiting here closes that: the caller's navigate() (AuthPage's `run()`) cannot fire, and Dashboard
  // cannot mount, until promotion has actually settled.
  //
  // Never rethrows — the local-first contract is that sign-in must succeed even when promotion
  // doesn't (drafts stay editable locally either way). A promotion failure is NOT invisible: the
  // project's sync record lands on `syncStatus: "failed"`, which the existing SyncBadge component
  // (apps/web/src/components/SyncBadge.tsx) surfaces as "Sync failed" with a Retry button once that
  // project is opened, and the reconnect monitor (ensureMonitor) retries automatically once any
  // SyncBadge has mounted. What this does NOT do: proactively surface a promotion failure on
  // Dashboard itself before the user opens the affected project — Dashboard has no failed-local-draft
  // affordance today, and adding one is a UI feature, not a repair of this mechanism.
  const adopt = useCallback(async (u: UserRecord) => {
    setUser(u);
    setStatus("authenticated");
    try {
      await promoteAllPending();
    } catch (error) {
      console.error("Failed to promote local drafts into the account", error);
    }
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
