import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Archive, ArrowRight, ChevronLeft, ChevronRight, Copy, MoreVertical, Pencil, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import type { RenderJob } from "@kimera-by-aelivion/shared";
import { deleteProject, duplicateProject, listJobs, listProjects, patchProject, type ProjectRecord } from "../lib/api";
import { shortDate } from "../lib/format";

const PAGE_SIZE = 9;

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "preview_ready", label: "Preview ready" },
  { key: "export_ready", label: "Export ready" },
  { key: "archived", label: "Archived" }
];

const STATUS_META: Record<string, { cls: string; label: string }> = {
  draft: { cls: "draft", label: "Draft" },
  preview_ready: { cls: "preview", label: "Preview ready" },
  export_ready: { cls: "export", label: "Export ready" },
  archived: { cls: "archived", label: "Archived" }
};

function statusMeta(status: string) {
  return STATUS_META[status] ?? { cls: "draft", label: status.replace(/_/g, " ") };
}

function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function projectFormat(project: ProjectRecord): string {
  const comp = project.projectGraph?.composition;
  if (!comp?.width || !comp?.height) return "9:16";
  return comp.width > comp.height ? "16:9" : comp.width === comp.height ? "1:1" : "9:16";
}

export function DashboardPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [jobs, setJobs] = useState<RenderJob[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    listProjects().then(setProjects);
    listJobs().then(setJobs);
  }, []);

  // Counts per status drive the filter pill badges. "All" is every ACTIVE project — archived ones
  // are tucked away and only surface under the Archived filter.
  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    let active = 0;
    for (const project of projects) {
      map[project.status] = (map[project.status] ?? 0) + 1;
      if (project.status !== "archived") active += 1;
    }
    map.all = active;
    return map;
  }, [projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((project) => {
      // "All" excludes archived; every other filter is an exact status match.
      if (filter === "all" ? project.status === "archived" : project.status !== filter) return false;
      if (!q) return true;
      const haystack = `${project.title} ${project.template?.name ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [projects, filter, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageItems = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Any change to the search/filter resets to page 1 so results are never hidden behind stale paging.
  useEffect(() => setPage(1), [query, filter]);

  const activeJobs = jobs.slice(0, 6);

  async function handleRename(project: ProjectRecord) {
    const next = window.prompt("Rename project", project.title)?.trim();
    if (!next || next === project.title) return;
    setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, title: next } : p)));
    await patchProject(project.id, { title: next });
  }

  async function handleDuplicate(project: ProjectRecord) {
    const copy = await duplicateProject(project.id);
    setProjects((prev) => [copy, ...prev]);
  }

  async function handleArchiveToggle(project: ProjectRecord) {
    const status = project.status === "archived" ? "draft" : "archived";
    setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, status } : p)));
    await patchProject(project.id, { status });
  }

  async function handleDelete(project: ProjectRecord) {
    if (!window.confirm(`Delete “${project.title}”? This can't be undone.`)) return;
    setProjects((prev) => prev.filter((p) => p.id !== project.id));
    await deleteProject(project.id);
  }

  return (
    <div className="mkt-page">
      <section className="mkt-hero" style={{ padding: "56px 0 0" }}>
        <div className="mkt-wrap mkt-dash-head">
          <div>
            <span className="mkt-eyebrow">Dashboard</span>
            <h1>Your projects</h1>
            <p className="lede">Jump back into an edit — every project stays right here, ready in one click.</p>
          </div>
          <button type="button" className="mkt-btn mkt-btn-primary" onClick={() => navigate("/create")}>
            <Plus size={16} /> New project
          </button>
        </div>
      </section>

      <div className="mkt-wrap" style={{ paddingBottom: 100 }}>
        {projects.length === 0 ? (
          <div className="mkt-empty">
            <h2>No projects yet</h2>
            <p>Start from a template, a prompt, or a blank timeline — your reels show up here.</p>
            <button type="button" className="mkt-btn mkt-btn-primary" onClick={() => navigate("/create")}>
              Create your first project
            </button>
          </div>
        ) : (
          <div className="mkt-dash-section">
            <div className="mkt-dash-toolbar">
              <div className="mkt-search">
                <Search size={15} />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search projects…"
                  aria-label="Search projects"
                />
              </div>
              <div className="mkt-filters" role="group" aria-label="Filter by status">
                {FILTERS.map((option) => {
                  const count = counts[option.key] ?? 0;
                  if (option.key !== "all" && count === 0) return null;
                  return (
                    <button
                      type="button"
                      key={option.key}
                      className="mkt-filter"
                      aria-pressed={filter === option.key}
                      onClick={() => setFilter(option.key)}
                    >
                      {option.label} <span className="count">{count}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {pageItems.length === 0 ? (
              <p className="mkt-no-match">
                {query.trim()
                  ? `No projects match “${query}”${filter !== "all" ? " in this status" : ""}.`
                  : filter === "all"
                    ? "No active projects — check the Archived filter."
                    : "No projects in this status."}
              </p>
            ) : (
              <div className="mkt-proj-grid">
                {pageItems.map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    onOpen={() => navigate(`/editor/${project.id}`)}
                    onRename={() => handleRename(project)}
                    onDuplicate={() => handleDuplicate(project)}
                    onArchiveToggle={() => handleArchiveToggle(project)}
                    onDelete={() => handleDelete(project)}
                  />
                ))}
              </div>
            )}

            {pageCount > 1 ? (
              <nav className="mkt-pager" aria-label="Projects pagination">
                <button type="button" onClick={() => setPage(safePage - 1)} disabled={safePage === 1} aria-label="Previous page">
                  <ChevronLeft size={15} />
                </button>
                {Array.from({ length: pageCount }, (_, index) => index + 1).map((n) => (
                  <button
                    type="button"
                    key={n}
                    aria-current={n === safePage}
                    onClick={() => setPage(n)}
                  >
                    {n}
                  </button>
                ))}
                <button type="button" onClick={() => setPage(safePage + 1)} disabled={safePage === pageCount} aria-label="Next page">
                  <ChevronRight size={15} />
                </button>
              </nav>
            ) : null}
          </div>
        )}

        {activeJobs.length > 0 ? (
          <div className="mkt-dash-section">
            <span className="mkt-flow-label">Recent renders</span>
            <div className="mkt-jobs">
              {activeJobs.map((job) => (
                <div className="mkt-job" key={job.id}>
                  <span className="jtype">{job.type}</span>
                  <span className="jbar" aria-hidden="true"><i style={{ width: `${job.progress}%` }} /></span>
                  <span className="jpct">{job.status} · {job.progress}%</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface ProjectCardProps {
  project: ProjectRecord;
  onOpen: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onArchiveToggle: () => void;
  onDelete: () => void;
}

function ProjectCard({ project, onOpen, onRename, onDuplicate, onArchiveToggle, onDelete }: ProjectCardProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const meta = statusMeta(project.status);
  const archived = project.status === "archived";

  useEffect(() => {
    if (!open) return;
    function onDocClick(event: MouseEvent) {
      if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Run a menu action without letting the click bubble to the card's open handler.
  const act = (fn: () => void) => (event: ReactMouseEvent) => {
    event.stopPropagation();
    setOpen(false);
    fn();
  };

  return (
    <div
      className="mkt-proj"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="mkt-proj-top">
        <span className="mkt-proj-fmt">{projectFormat(project)}</span>
        <div className="mkt-proj-topright">
          <span className={`mkt-status ${meta.cls}`}>{meta.label}</span>
          <div className="mkt-menu-anchor" ref={anchorRef}>
            <button
              type="button"
              className="mkt-kebab"
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label="Project options"
              onClick={(event) => {
                event.stopPropagation();
                setOpen((prev) => !prev);
              }}
            >
              <MoreVertical size={16} />
            </button>
            {open ? (
              <div className="mkt-menu" role="menu">
                <button type="button" role="menuitem" onClick={act(onOpen)}><ArrowRight size={15} /> Open</button>
                <button type="button" role="menuitem" onClick={act(onRename)}><Pencil size={15} /> Rename</button>
                <button type="button" role="menuitem" onClick={act(onDuplicate)}><Copy size={15} /> Duplicate</button>
                <button type="button" role="menuitem" onClick={act(onArchiveToggle)}>
                  {archived ? <><RotateCcw size={15} /> Unarchive</> : <><Archive size={15} /> Archive</>}
                </button>
                <div className="sep" />
                <button type="button" role="menuitem" className="danger" onClick={act(onDelete)}><Trash2 size={15} /> Delete</button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <h3>{project.title}</h3>
      <p className="meta">
        {project.template?.name ?? "Blank project"} · {shortDate(project.updatedAt)}
      </p>
      <div className="mkt-proj-foot">
        <span className="dur">{formatDuration(project.durationSeconds)}</span>
        <span className="open">Open <ArrowRight size={14} /></span>
      </div>
    </div>
  );
}
