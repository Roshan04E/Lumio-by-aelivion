import { useEffect, useState } from "react";
import { templateDefinitions, type TemplateDefinition } from "@kimera-by-aelivion/shared";
import { Badge } from "../components/Badge";
import { Card } from "../components/Card";
import { listTemplates } from "../lib/api";

export function AdminTemplatesPage() {
  const [templates, setTemplates] = useState<TemplateDefinition[]>(templateDefinitions);

  useEffect(() => {
    listTemplates().then(setTemplates);
  }, []);

  return (
    <div className="page">
      <section className="page-heading">
        <Badge tone="lime">Admin</Badge>
        <h1>Template inventory</h1>
        <p>Seeded templates are stored as module graphs with editable field definitions.</p>
      </section>

      <div className="admin-table">
        {templates.map((template) => (
          <Card className="admin-row" key={template.id}>
            <div>
              <h2>{template.name}</h2>
              <p>{template.slug}</p>
            </div>
            <Badge tone="muted">{template.category}</Badge>
            <span>{template.requiredModules.length} modules</span>
            <span>{template.durationSeconds}s</span>
          </Card>
        ))}
      </div>
    </div>
  );
}
