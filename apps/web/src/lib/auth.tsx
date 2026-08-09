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

// See the comment at `adopt` below for why this value and why it is a race, not a hard cap.
const ADOPT_PROMOTE_TIMEOUT_MS = 8000;

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
  // AWAITED (was `void promoteAllPending()`, fire-and-forget), BOUNDED (2026-08-09) rather than
  // fully awaited. History, so the next reader doesn't re-derive it:
  //   - unawaited: a full page reload fired the instant sign-in completed reliably ABORTED the
  //     in-flight promotion (`syncStatus` landed on "failed", no `serverId`);
  //   - awaited outright: closes that, BUT this project's `AuthPage.tsx` has a SEPARATE `useEffect`
  //     watching `status` that navigates the instant `status` flips to "authenticated" — which
  //     happens synchronously at the top of THIS function, before any await below runs. So an
  //     unbounded await here never actually delayed navigation; it only delayed what THIS
  //     function's own returned promise resolves to. Measured: the effect-driven navigate fires
  //     ~6ms after status flips, while promotion can take 8+ seconds. Left unfixed here — it is a
  //     separate defect in AuthPage, reported, not this file's to fix — but it means the bound
  //     below is not "the thing standing between the user and a stuck screen" the way it would be
  //     if this were the only navigate; it exists for the callers that DO wait on this promise
  //     directly, and so the 2a waking banner (a global flag, unaffected by which component is
  //     mounted) has a bounded, legible window to describe instead of an open-ended one.
  //
  // BOUND = 8000ms: `promoteAllPending` is a SEQUENTIAL loop, one round-trip set per pending local
  // draft (sync.ts) — on an already-warm connection that is fast regardless (single digit seconds
  // for the common 1-2-draft case), but a slow or throttled connection with several drafts must not
  // scale this function's wait time linearly with draft count. Sized against the 2a waking
  // threshold (2750ms) rather than the ~60s Render cold-start figure: a cold start is a one-time
  // cost normally paid by the LOGIN request itself (which resolves before this function is even
  // called), not by the sync loop that follows it on an already-woken connection.
  //
  // NOT CANCELLED. Whichever side of the race loses, `promoteAllPending()` keeps running to
  // completion in the background — its own `upsertProject()` calls persist regardless of whether
  // anything is still awaiting the outer promise, observed later via `syncStatus`/SyncBadge and the
  // reconnect monitor (ensureMonitor), exactly as before this bound existed.
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
    const promotion = promoteAllPending().catch((error) => {
      console.error("Failed to promote local drafts into the account", error);
    });
    await Promise.race([promotion, new Promise<void>((resolve) => window.setTimeout(resolve, ADOPT_PROMOTE_TIMEOUT_MS))]);
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
