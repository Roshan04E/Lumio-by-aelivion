import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Navbar } from "./Navbar";
import { Footer } from "./Footer";

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const isEditor = location.pathname.startsWith("/editor/");
  const isAuth = location.pathname === "/login";
  const chromeless = isEditor || isAuth;

  return (
    <div className={`app-shell ${isEditor ? "app-shell-editor" : ""}`}>
      {chromeless ? null : <Navbar />}
      <main>{children}</main>
      {chromeless ? null : <Footer />}
    </div>
  );
}
