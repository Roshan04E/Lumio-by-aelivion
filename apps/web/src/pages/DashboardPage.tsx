import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { RenderJob } from "@lumio-by-aelivion/shared";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { JobStatusPill } from "../components/JobStatusPill";
import { listJobs, listProjects, type ProjectRecord } from "../lib/api";
import { shortDate } from "../lib/format";

export function DashboardPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [jobs, setJobs] = useState<RenderJob[]>([]);

  useEffect(() => {
    listProjects().then(setProjects);
    listJobs().then(setJobs);
  }, []);

  return (
    <div className="page">
      <section className="section-heading">
        <div>
          <Badge tone="lime">Dashboard</Badge>
          <h1>Your reel projects</h1>
        </div>
        <Button onClick={() => navigate("/create")}>New Project</Button>
      </section>

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          body="Create a template or prompt-planned reel to see it here."
          action="Create Project"
          onAction={() => navigate("/create")}
        />
      ) : (
        <div className="project-list">
          {projects.map((project) => (
            <Card className="project-row" key={project.id}>
              <div>
                <h2>{project.title}</h2>
                <p>{project.template?.name ?? "Custom graph"} - {shortDate(project.updatedAt)}</p>
              </div>
              <Badge tone="muted">{project.status}</Badge>
              <Link to={`/editor/${project.id}`}>Open</Link>
            </Card>
          ))}
        </div>
      )}

      <section className="section-heading compact">
        <div>
          <Badge tone="muted">Jobs</Badge>
          <h2>Recent renders</h2>
        </div>
      </section>
      <div className="job-table">
        {jobs.slice(0, 6).map((job) => (
          <Card className="job-row" key={job.id}>
            <span>{job.type}</span>
            <JobStatusPill status={job.status} />
            <strong>{job.progress}%</strong>
          </Card>
        ))}
      </div>
    </div>
  );
}
