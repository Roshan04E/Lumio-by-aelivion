import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { templateDefinitions, type TemplateDefinition } from "@lumio-by-aelivion/shared";
import { Badge } from "../components/Badge";
import { TemplateCard } from "../components/TemplateCard";
import { createAsset, createProject, listTemplates } from "../lib/api";

export function TemplatesPage() {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<TemplateDefinition[]>(templateDefinitions);

  useEffect(() => {
    listTemplates().then(setTemplates).catch(() => setTemplates(templateDefinitions));
  }, []);

  async function useTemplate(template: TemplateDefinition) {
    const asset = await createAsset({ fileName: "template-demo-clip.mp4", durationSeconds: template.durationSeconds });
    const project = await createProject({
      title: template.name,
      templateId: template.id,
      sourceAssetId: asset.id
    });
    navigate(`/editor/${project.id}`);
  }

  return (
    <div className="page">
      <section className="page-heading">
        <Badge tone="lime">Templates</Badge>
        <h1>Pick a reel stack</h1>
        <p>Every template is an editable effect graph, not a locked preset.</p>
      </section>

      <div className="template-grid">
        {templates.map((template) => (
          <TemplateCard key={template.id} template={template} onUse={() => useTemplate(template)} />
        ))}
      </div>
    </div>
  );
}
