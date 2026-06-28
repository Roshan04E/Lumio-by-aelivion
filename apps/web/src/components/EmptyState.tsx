import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "./Button";

export function EmptyState({
  title,
  body,
  action,
  onAction
}: {
  title: string;
  body: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <Sparkles size={24} />
      <h2>{title}</h2>
      <p>{body}</p>
      {action && onAction ? <Button onClick={onAction}>{action}</Button> : null}
    </div>
  );
}

export function InlineEmpty({ children }: { children: ReactNode }) {
  return <div className="inline-empty">{children}</div>;
}
