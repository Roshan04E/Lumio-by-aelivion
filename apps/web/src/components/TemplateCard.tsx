import { ArrowRight, Clock3, Layers3 } from "lucide-react";
import type { TemplateDefinition } from "@lumio-by-aelivion/shared";
import { Button } from "./Button";
import { Card } from "./Card";
import { CreditBadge } from "./CreditBadge";

export function TemplateCard({ template, onUse }: { template: TemplateDefinition; onUse: () => void }) {
  return (
    <Card className="template-card">
      <div className="template-poster" style={{ backgroundImage: "url('/assets/lumio-by-aelivion-hero.png')" }}>
        <span>{template.category}</span>
      </div>
      <div className="template-card-body">
        <div>
          <h3>{template.name}</h3>
          <p>{template.description}</p>
        </div>
        <div className="template-meta">
          <span>
            <Clock3 size={14} />
            {template.durationSeconds}s
          </span>
          <span>
            <Layers3 size={14} />
            {template.requiredModules.length} modules
          </span>
          <CreditBadge value={template.creditCost} />
        </div>
        <Button icon={<ArrowRight size={16} />} onClick={onUse}>
          Use Template
        </Button>
      </div>
    </Card>
  );
}
