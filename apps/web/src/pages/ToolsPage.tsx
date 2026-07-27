import { useNavigate } from "react-router-dom";
import { ArrowRight, Captions, Eraser, Layers, Scissors, Move3d, Wrench, type LucideIcon } from "lucide-react";
import { stageLabel, toolCapabilityDefinitions, type ToolCapabilityDefinition, type ToolIconKey } from "@orreris/shared";
import { DISABLED_TOOL_SLUGS } from "../tools/ready-tool-slugs";

/** Single seam between the registry's icon keys and web's glyph set.
 *  A new tool declares `icon` in packages/shared; add its key here (or it falls back to the wrench). */
const TOOL_ICONS: Record<ToolIconKey, LucideIcon> = {
  captions: Captions,
  "text-behind": Layers,
  "background-removal": Eraser,
  "follow-text": Move3d,
  "person-extraction": Scissors,
  generic: Wrench
};

function toolIcon(tool: ToolCapabilityDefinition): LucideIcon {
  return TOOL_ICONS[tool.icon ?? "generic"] ?? Wrench;
}

export function ToolsPage() {
  const navigate = useNavigate();

  return (
    <div className="mkt-page">
      <section className="mkt-hero" style={{ padding: "64px 0 8px" }}>
        <div className="mkt-wrap mkt-hero-inner">
          <span className="mkt-eyebrow">Tools</span>
          <h1 style={{ fontSize: "clamp(32px, 4.4vw, 52px)" }}>
            Creator AI tools. <span className="mkt-grad">Yours to run, free or integrated.</span>
          </h1>
          <p className="mkt-sub">
            Run any tool with your own chat assistant for free, or let Orreris run it for you. Every result
            comes back as editable timeline data — never a locked export.
          </p>
        </div>
      </section>

      <section className="mkt-section" style={{ paddingTop: 40 }}>
        <div className="mkt-wrap">
          <div className="mkt-tool-grid">
            {toolCapabilityDefinitions
              .filter((tool) => !DISABLED_TOOL_SLUGS.includes(tool.slug))
              .map((tool) => {
              const Icon = toolIcon(tool);
              const credits = tool.estimatedCredits ?? 0;
              return (
                <article className="mkt-tool" key={tool.id}>
                  <span className="mkt-ic"><Icon size={18} /></span>
                  <h3>{tool.name}</h3>
                  <p>{tool.shortDescription}</p>
                  {tool.bestFor ? <p className="best">Best for: {tool.bestFor}</p> : null}
                  <div className="mkt-tool-stages">
                    {tool.stages.slice(0, 4).map((stage) => (
                      <span className="mkt-chip" key={stage}>{stageLabel(stage)}</span>
                    ))}
                  </div>
                  <span className="mkt-tool-spacer" />
                  <div className="mkt-tool-foot">
                    <span className={`mkt-credits ${credits === 0 ? "free" : ""}`}>
                      {credits === 0 ? "Free" : `${credits} credits`}
                    </span>
                    <button type="button" className="mkt-linkbtn" onClick={() => navigate(`/tools/${tool.slug}`)}>
                      Open <ArrowRight size={15} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
