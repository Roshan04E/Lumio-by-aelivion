import type { ReactNode } from "react";

export function Sidebar({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="sidebar">
      <h2>{title}</h2>
      {children}
    </aside>
  );
}
