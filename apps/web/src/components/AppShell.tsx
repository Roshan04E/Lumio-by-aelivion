import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Navbar } from "./Navbar";

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();
  const isEditor = location.pathname.startsWith("/editor/");
  const isAuth = location.pathname === "/login";

  return (
    <div className={`app-shell ${isEditor ? "app-shell-editor" : ""}`}>
      {isEditor || isAuth ? null : <Navbar />}
      <main>{children}</main>
    </div>
  );
}
