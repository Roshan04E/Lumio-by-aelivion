import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { Check } from "lucide-react";
import { useAuth } from "../lib/auth";
import { BrandMark } from "../components/BrandMark";
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
    <main className="mkt-auth">
      <aside className="mkt-auth-aside">
        <Link to="/" aria-label="Lumio home"><BrandMark /></Link>
        <div>
          <h2>Pro video editing in the browser. <span className="mkt-grad">AI on your terms.</span></h2>
          <ul className="mkt-auth-points">
            <li><Check size={17} /><span>A real timeline with WebGL effects, color grading &amp; keyframes.</span></li>
            <li><Check size={17} /><span>AI tools you can run <b>free</b> with your own chat, or integrated.</span></li>
            <li><Check size={17} /><span>Exports encode <b>locally</b> — your footage never leaves your machine.</span></li>
          </ul>
        </div>
        <p className="mkt-auth-quote">// nothing is baked or locked — every result stays editable</p>
      </aside>

      <section className="mkt-auth-main">
        <div className="mkt-auth-card">
          <Link to="/" aria-label="Lumio home"><BrandMark /></Link>
          <h1 className="mkt-auth-title">{mode === "signup" ? "Create your account" : "Welcome back"}</h1>
          <p className="mkt-auth-lede">{mode === "signup" ? "Start editing free — no credit card." : "Sign in to pick up where you left off."}</p>

          <div className="mkt-auth-tabs" role="tablist" aria-label="Sign in or create account">
            <button type="button" role="tab" className={mode === "signin" ? "is-active" : ""} onClick={() => setMode("signin")}>
              Sign in
            </button>
            <button type="button" role="tab" className={mode === "signup" ? "is-active" : ""} onClick={() => setMode("signup")}>
              Create account
            </button>
          </div>

          <form className="mkt-auth-form" onSubmit={onSubmit}>
            {mode === "signup" ? (
              <label className="mkt-field">
                <span>Name</span>
                <input className="mkt-input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" minLength={2} required placeholder="Your name" />
              </label>
            ) : null}
            <label className="mkt-field">
              <span>Email</span>
              <input className="mkt-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required placeholder="you@example.com" />
            </label>
            <label className="mkt-field">
              <span>Password</span>
              <input
                className="mkt-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                minLength={mode === "signup" ? 8 : 1}
                required
                placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
              />
            </label>

            {error ? <p className="mkt-auth-error">{error}</p> : null}

            <button type="submit" className="mkt-btn mkt-btn-primary" disabled={busy}>
              {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>

          <div className="mkt-auth-divider">or</div>

          <div className="mkt-auth-alt">
            <GoogleSignInButton onCredential={(credential) => void run(() => loginWithGoogle(credential))} />
            <button type="button" className="mkt-btn mkt-btn-ghost" style={{ justifyContent: "center" }} disabled={busy} onClick={() => void run(() => loginDemo())}>
              Try the demo
            </button>
          </div>

          <p className="mkt-auth-foot">
            You can keep editing drafts on this device without an account — signing in unlocks cloud sync and export.
          </p>
        </div>
      </section>
    </main>
  );
}
