import { Badge } from "./Badge";

export function JobStatusPill({ status }: { status: string }) {
  const tone = status === "completed" ? "success" : status === "failed" || status === "cancelled" ? "danger" : "lime";
  return <Badge tone={tone}>{status.replace(/_/g, " ")}</Badge>;
}
