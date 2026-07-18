import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Clock3, FilePlus2, Layers, Search } from "lucide-react";
import { templateDefinitions, type TemplateDefinition } from "@orreris/shared";
import { createAsset, createProject, listTemplates } from "../lib/api";

/** Stable hue per string so each template/category gets its own colorful poster. */
function hueFor(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) % 360;
  return hash;
}

export function TemplatesPage() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<TemplateDefinition[]>(templateDefinitions);
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    listTemplates().then(setTemplates).catch(() => setTemplates(templateDefinitions));
  }, []);

  const categories = useMemo(() => {
    const seen = new Map<string, number>();
    for (const template of templates) seen.set(template.category, (seen.get(template.category) ?? 0) + 1);
    return [...seen].map(([key, count]) => ({ key, count }));
  }, [templates]);

  const q = query.trim().toLowerCase();
  const browsing = q.length > 0 || category !== "all";

  const visible = useMemo(
    () =>
      templates.filter((template) => {
        if (category !== "all" && template.category !== category) return false;
        if (!q) return true;
        return `${template.name} ${template.description} ${template.category}`.toLowerCase().includes(q);
      }),
    [templates, category, q]
  );

  const sections = useMemo(() => {
    const byCat = new Map<string, TemplateDefinition[]>();
    for (const template of templates) {
      const list = byCat.get(template.category) ?? [];
      list.push(template);
      byCat.set(template.category, list);
    }
    return [...byCat];
  }, [templates]);

  async function useTemplate(template: TemplateDefinition) {
    setBusyId(template.id);
    const asset = await createAsset({ fileName: "template-demo-clip.mp4", durationSeconds: template.durationSeconds });
    const project = await createProject({ title: template.name, templateId: template.id, sourceAssetId: asset.id });
    navigate(`/editor/${project.id}`);
  }

  async function startBlank(orientation: "portrait" | "landscape") {
    setBusyId(`blank-${orientation}`);
    const project = await createProject({ title: "Untitled project", orientation });
    navigate(`/editor/${project.id}`);
  }

  return (
    <div className="mkt-page">
      {/* ---- compact search-forward hero ---- */}
      <section className="mkt-hero mkt-tpl-hero">
        <div className="mkt-wrap mkt-hero-inner">
          <h1 className="mkt-tpl-title">Templates</h1>
          <p className="mkt-tpl-tag">Creator-ready stacks for Reels, Shorts &amp; promos — pick one and edit everything.</p>

          <div className="mkt-tpl-search">
            <Search size={18} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search templates — captions, promo, follow text…"
              aria-label="Search templates"
            />
          </div>

          <div className="mkt-tpl-pills">
            <button type="button" className="mkt-filter" aria-pressed={category === "all"} onClick={() => setCategory("all")}>
              All <span className="count">{templates.length}</span>
            </button>
            {categories.map((cat) => (
              <button type="button" className="mkt-filter" key={cat.key} aria-pressed={category === cat.key} onClick={() => setCategory(cat.key)}>
                <span className="swatch" style={{ background: `hsl(${hueFor(cat.key)} 65% 55%)` }} /> {cat.key} <span className="count">{cat.count}</span>
              </button>
            ))}
            <span className="mkt-pill-sep" />
            <button type="button" className="mkt-filter start" disabled={busyId === "blank-portrait"} onClick={() => startBlank("portrait")}>
              <span className="frame p" /> Reel 9:16
            </button>
            <button type="button" className="mkt-filter start" disabled={busyId === "blank-landscape"} onClick={() => startBlank("landscape")}>
              <span className="frame l" /> Landscape 16:9
            </button>
            <button type="button" className="mkt-filter start" onClick={() => navigate("/create")}>
              <FilePlus2 size={13} /> From a video
            </button>
          </div>
        </div>
      </section>

      {/* ---- gallery ---- */}
      <section style={{ padding: "8px 0 100px" }}>
        <div className="mkt-wrap">
          {browsing ? (
            <div className="mkt-tpl-section">
              <div className="mkt-tpl-secthead">
                <h2>{category === "all" ? "Search results" : category}</h2>
                <span className="count">{visible.length} result{visible.length === 1 ? "" : "s"}</span>
              </div>
              {visible.length === 0 ? (
                <p className="mkt-no-match">No templates match “{query}”{category !== "all" ? ` in ${category}` : ""}. Try another search.</p>
              ) : (
                <TemplateGrid templates={visible} busyId={busyId} onUse={useTemplate} />
              )}
            </div>
          ) : (
            sections.map(([cat, list]) => (
              <div className="mkt-tpl-section" key={cat}>
                <div className="mkt-tpl-secthead">
                  <h2>{cat}</h2>
                  <button type="button" className="mkt-linkbtn" onClick={() => setCategory(cat)}>
                    See all <ArrowRight size={15} />
                  </button>
                </div>
                <TemplateGrid templates={list.slice(0, 6)} busyId={busyId} onUse={useTemplate} />
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function TemplateGrid({
  templates,
  busyId,
  onUse
}: {
  templates: TemplateDefinition[];
  busyId: string | null;
  onUse: (template: TemplateDefinition) => void;
}) {
  return (
    <div className="mkt-tpl-grid">
      {templates.map((template) => {
        const credits = template.creditCost ?? 0;
        return (
          <article className="mkt-tpl" key={template.id}>
            <div className="mkt-tpl-poster" style={{ ["--hue" as string]: String(hueFor(template.id + template.name)) }}>
              <span className="cat">{template.category}</span>
              <span className="frames" aria-hidden="true" />
            </div>
            <div className="mkt-tpl-body">
              <h3>{template.name}</h3>
              <p>{template.description}</p>
              <div className="mkt-tpl-meta">
                <span><Clock3 size={13} /> {template.durationSeconds}s</span>
                <span><Layers size={13} /> {template.requiredModules.length} modules</span>
              </div>
              <div className="mkt-tpl-foot">
                <span className={`mkt-tpl-credits ${credits === 0 ? "free" : ""}`}>
                  {credits === 0 ? "Free" : `${credits} credits`}
                </span>
                <button type="button" className="mkt-linkbtn" disabled={busyId === template.id} onClick={() => onUse(template)}>
                  {busyId === template.id ? "Opening…" : "Use template"} <ArrowRight size={15} />
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
