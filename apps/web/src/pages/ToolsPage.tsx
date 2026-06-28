import { useNavigate } from "react-router-dom";
import { toolCapabilityDefinitions } from "@reelforge/shared";
import { Badge } from "../components/Badge";
import { ToolCard } from "../components/ToolCard";

export function ToolsPage() {
  const navigate = useNavigate();

  function openTool(slug: string) {
    navigate(`/tools/${slug}`);
  }

  return (
    <div className="page">
      <section className="page-heading">
        <Badge tone="lime">Tools</Badge>
        <h1>Creator tool capabilities</h1>
        <p>Use tools directly, or let AI call the same capabilities later. Every result becomes editable timeline data.</p>
      </section>

      <div className="tool-grid">
        {toolCapabilityDefinitions.map((tool) => (
          <ToolCard key={tool.id} tool={tool} onStart={() => openTool(tool.slug)} />
        ))}
      </div>
    </div>
  );
}
