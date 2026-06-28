import { useCallback, useEffect, useState } from "react";
import type { RenderJob } from "@reelforge/shared";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { JobStatusPill } from "../components/JobStatusPill";
import { cancelJob, listJobs } from "../lib/api";
import { shortDate } from "../lib/format";

const CANCELLABLE = new Set(["queued", "processing"]);

export function AdminJobsPage() {
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listJobs().then(setJobs);
  }, []);

  useEffect(() => {
    refresh();
    // Keep the list live so progress/cancellation are reflected without a manual reload.
    const interval = window.setInterval(refresh, 2000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  async function handleCancel(id: string) {
    setCancelling(id);
    try {
      await cancelJob(id);
      refresh();
    } finally {
      setCancelling(null);
    }
  }

  return (
    <div className="page">
      <section className="page-heading">
        <Badge tone="lime">Admin</Badge>
        <h1>Render jobs</h1>
        <p>Preview and final export jobs from the mock processing pipeline.</p>
      </section>

      <div className="admin-table">
        {jobs.map((job) => (
          <Card className="admin-row" key={job.id}>
            <div>
              <h2>{job.type}</h2>
              <p>{job.id}</p>
            </div>
            <JobStatusPill status={job.status} />
            <span>{job.progress}%</span>
            <span>{shortDate(job.createdAt)}</span>
            {CANCELLABLE.has(job.status) ? (
              <Button variant="secondary" disabled={cancelling === job.id} onClick={() => handleCancel(job.id)}>
                {cancelling === job.id ? "Cancelling…" : "Cancel"}
              </Button>
            ) : (
              <span />
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
