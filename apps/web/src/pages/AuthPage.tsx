import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { Clapperboard } from "lucide-react";
import { useAuth } from "../lib/auth";
import { Button } from "../components/Button";
import { GoogleSignInButton } from "../components/GoogleSignInButton";

type Mode = "signin" | "signup";

export function AuthPage() {
  const { status, login, signup, loginWithGoogle, loginDemo } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const from = params.get("from") || "/dashboard";

  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Already signed in → leave the auth page.
  useEffect(() => {
    if (status === "authenticated") navigate(from, { replace: true });
  }, [status, from, navigate]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        navigate(from, { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
      } finally {
        setBusy(false);
      }
    },
    [from, navigate]
  );

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (mode === "signup") {
      void run(() => signup(name.trim(), email.trim(), password));
    } else {
      void run(() => login(email.trim(), password));
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <Link to="/" className="auth-brand" aria-label="ReelForge Studio">
          <span className="brand-mark">
            <Clapperboard size={20} />
          </span>
          <span>ReelForge Studio</span>
        </Link>

        <div className="auth-tabs" role="tablist" aria-label="Sign in or create account">
          <button type="button" role="tab" className={mode === "signin" ? "is-active" : ""} onClick={() => setMode("signin")}>
            Sign in
          </button>
          <button type="button" role="tab" className={mode === "signup" ? "is-active" : ""} onClick={() => setMode("signup")}>
            Create account
          </button>
        </div>

        <form className="auth-form" onSubmit={onSubmit}>
          {mode === "signup" ? (
            <label className="auth-field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" minLength={2} required placeholder="Your name" />
            </label>
          ) : null}
          <label className="auth-field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required placeholder="you@example.com" />
          </label>
          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              minLength={mode === "signup" ? 8 : 1}
              required
              placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
            />
          </label>

          {error ? <p className="auth-error">{error}</p> : null}

          <Button type="submit" disabled={busy}>
            {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
          </Button>
        </form>

        <div className="auth-divider"><span>or</span></div>

        <div className="auth-alt">
          <GoogleSignInButton onCredential={(credential) => void run(() => loginWithGoogle(credential))} />
          <Button variant="secondary" disabled={busy} onClick={() => void run(() => loginDemo())}>
            Try demo
          </Button>
        </div>

        <p className="auth-foot">
          You can keep editing drafts on this device without an account — signing in unlocks cloud sync and export.
        </p>
      </div>
    </main>
  );
}
