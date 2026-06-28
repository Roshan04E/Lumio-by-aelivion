import { useState } from "react";
import { Link } from "react-router-dom";
import { LogOut, User } from "lucide-react";
import { useAuth } from "../lib/auth";

export function AccountMenu() {
  const { status, user, logout } = useAuth();
  const [open, setOpen] = useState(false);

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
