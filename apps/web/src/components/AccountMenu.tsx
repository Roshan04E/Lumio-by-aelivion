import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LogOut, User } from "lucide-react";
import { useAuth } from "../lib/auth";
import { fetchUsage, type UsageSummary } from "../lib/api";

export function AccountMenu() {
  const { status, user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<UsageSummary | null>(null);

  useEffect(() => {
    if (open && status === "authenticated" && !usage) {
      fetchUsage().then(setUsage);
    }
  }, [open, status, usage]);

  if (status === "loading") {
    return <span className="account-menu-loading" aria-hidden="true" />;
  }

  if (status !== "authenticated" || !user) {
    return (
      <Link to="/login" className="nav-signin">
        Sign in
      </Link>
    );
  }

  const initial = (user.name || user.email || "?").charAt(0).toUpperCase();

  return (
    <div className="account-menu">
      <button
        type="button"
        className="account-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user.email}
      >
        <span className="account-avatar">{initial}</span>
      </button>
      {open ? (
        <>
          <div className="account-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="account-dropdown" role="menu">
            <div className="account-identity">
              <span className="account-avatar account-avatar-lg">
                <User size={16} />
              </span>
              <div>
                <strong>{user.name}</strong>
                <span>{user.email}</span>
              </div>
            </div>
            <div className="account-credits">{user.walletCredits} credits</div>
            {usage && usage.byAction.length > 0 ? (
              <div className="account-usage">
                <span className="account-usage-title">Usage this month <em>free during beta</em></span>
                <span className="account-usage-total">{usage.totalShadowCredits} credits measured</span>
              </div>
            ) : null}
            <button
              type="button"
              className="account-action"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                logout();
              }}
            >
              <LogOut size={15} />
              Log out
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
