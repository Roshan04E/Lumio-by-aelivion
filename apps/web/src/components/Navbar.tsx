import { Link, NavLink } from "react-router-dom";
import { Sparkles } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { AccountMenu } from "./AccountMenu";
import { usePro } from "../lib/proMode";

const navItems = [
  { to: "/tools", label: "Tools" },
  { to: "/templates", label: "Templates" },
  { to: "/cookbook", label: "Cookbook" },
  { to: "/dashboard", label: "Dashboard" }
];

export function Navbar() {
  const [pro, setPro] = usePro();
  return (
    <header className="mkt-nav">
      <div className="mkt-nav-inner">
        <Link to="/" aria-label="Orreris Pro home">
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
        <AccountMenu />
        <Link to="/create" className="mkt-btn mkt-btn-primary">
          Start editing free
        </Link>
        <button
          type="button"
          role="switch"
          aria-checked={pro}
          aria-label="Toggle AI (Pro) features"
          className={`mkt-pro-toggle${pro ? " is-on" : ""}`}
          onClick={() => setPro(!pro)}
          title={pro ? "AI features ON — click to turn off" : "AI features OFF — click to turn on"}
        >
          <Sparkles size={15} />
          <span className="mkt-pro-track"><span className="mkt-pro-thumb" /></span>
        </button>
      </div>
    </header>
  );
}
