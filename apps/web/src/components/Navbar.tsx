import { Link, NavLink } from "react-router-dom";
import { BrandMark } from "./BrandMark";

const navItems = [
  { to: "/tools", label: "Tools" },
  { to: "/templates", label: "Templates" },
  { to: "/cookbook", label: "Cookbook" },
  { to: "/dashboard", label: "Dashboard" }
];

export function Navbar() {
  return (
    <header className="mkt-nav">
      <div className="mkt-nav-inner">
        <Link to="/" aria-label="Kimera home">
          <BrandMark />
        </Link>

        <nav className="mkt-nav-links" aria-label="Main navigation">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")}>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <span className="mkt-nav-spacer" />
        <NavLink to="/login" className="mkt-nav-ghost">
          Sign in
        </NavLink>
        <Link to="/create" className="mkt-btn mkt-btn-primary">
          Start editing free
        </Link>
      </div>
    </header>
  );
}
