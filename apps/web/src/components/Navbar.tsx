import { Link, NavLink } from "react-router-dom";
import { Clapperboard, LayoutDashboard, WandSparkles } from "lucide-react";
import { AccountMenu } from "./AccountMenu";

const navItems = [
  { to: "/templates", label: "Templates" },
  { to: "/tools", label: "Tools" },
  { to: "/cookbook", label: "Cookbook" },
  { to: "/create", label: "Create" },
  { to: "/dashboard", label: "Dashboard" }
];

export function Navbar() {
  return (
    <header className="navbar">
      <Link to="/" className="brand" aria-label="Lumio">
        <span className="brand-mark">
          <Clapperboard size={20} />
        </span>
        <span>Lumio</span>
      </Link>

      <nav className="nav-links" aria-label="Main navigation">
        {navItems.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")}>
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="nav-actions">
        <NavLink to="/admin/jobs" className="icon-link" title="Jobs">
          <LayoutDashboard size={18} />
        </NavLink>
        <NavLink to="/create" className="nav-cta">
          <WandSparkles size={16} />
          Forge
        </NavLink>
        <AccountMenu />
      </div>
    </header>
  );
}
