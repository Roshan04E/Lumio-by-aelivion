import type { HTMLAttributes } from "react";

type BadgeTone = "lime" | "muted" | "success" | "danger";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

export function Badge({ tone = "muted", className = "", ...props }: BadgeProps) {
  return <span className={`badge badge-${tone} ${className}`} {...props} />;
}
