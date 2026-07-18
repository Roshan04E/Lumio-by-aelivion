import { Link } from "react-router-dom";
import { BrandMark } from "./BrandMark";

export function Footer() {
  return (
    <footer className="mkt-footer">
      <div className="mkt-foot">
        <Link to="/" aria-label="Orreris Pro home">
          <BrandMark />
        </Link>
        <span className="push" />
        <Link to="/tools">Tools</Link>
        <Link to="/templates">Templates</Link>
        <Link to="/cookbook">Cookbook</Link>
        <Link to="/dashboard">Dashboard</Link>
        <span className="copy">© 2026 Orreris Pro by Pesamee — pro video editing in the browser.</span>
      </div>
    </footer>
  );
}
