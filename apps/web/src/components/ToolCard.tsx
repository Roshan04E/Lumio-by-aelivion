import { ArrowRight, Wrench } from "lucide-react";
import { stageLabel, type ToolCapabilityDefinition } from "@lumio-by-aelivion/shared";
import { Button } from "./Button";
import { Card } from "./Card";
import { CreditBadge } from "./CreditBadge";

export function ToolCard({ tool, onStart }: { tool: ToolCapabilityDefinition; onStart: () => void }) {
  return (
    <Card className="tool-card">
      <div className="tool-icon">
        <Wrench size={20} />
      </div>
      <h3>{tool.name}</h3>
      <p>{tool.shortDescription}</p>
      <small>{tool.bestFor}</small>
      <div className="tool-steps">
        {tool.stages.slice(0, 4).map((step) => (
          <span key={step}>{stageLabel(step)}</span>
        ))}
      </div>
      <div className="tool-footer">
        <CreditBadge value={tool.estimatedCredits ?? 0} />
        <Button icon={<ArrowRight size={16} />} onClick={onStart}>
          Open
        </Button>
      </div>
    </Card>
  );
}
