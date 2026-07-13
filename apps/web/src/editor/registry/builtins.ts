import { timelineEffectRegistry, toolCapabilityDefinitions } from "@kimera-by-aelivion/shared";
import { registerBuiltinInspectorPanels } from "../inspector/panels";
import { commandRegistry } from "./commands";
import { moduleRegistry } from "./modules";

/**
 * Seed the registries from the existing source-of-truth definitions in
 * `packages/shared`. This *describes* current features into the module/command
 * model — it never duplicates their logic. Idempotent: safe to call once at boot.
 *
 * Phase 4 will attach `inspectorPanels` / `previewOverlays` / `load()` to these
 * modules as each feature is migrated out of the `EditorPage` monolith.
 */
let seeded = false;

export function seedBuiltinRegistries(): void {
  if (seeded) {
    return;
  }
  seeded = true;

  registerBuiltinInspectorPanels();

  // Tools → "tool" modules (capabilities gate which adapters can run).
  for (const tool of toolCapabilityDefinitions) {
    moduleRegistry.register({
      id: `tool:${tool.slug}`,
      name: tool.name,
      type: "tool",
      timelineActions: tool.timelineActions ? [...tool.timelineActions] : []
    });
  }

  // Effects → "effect" modules (params already schema-driven in the effect registry).
  for (const effect of timelineEffectRegistry) {
    moduleRegistry.register({
      id: `effect:${effect.type}`,
      name: effect.name,
      type: "effect",
      timelineActions: ["addEffect", "updateEffect", "removeEffect"]
    });
  }

  // AI command surface (drives the Command Palette; each maps to a planner intent).
  const aiCommands: { id: string; title: string }[] = [
    { id: "ai.captions", title: "Auto captions" },
    { id: "ai.removeBackground", title: "Remove background" },
    { id: "ai.textBehindSubject", title: "Text behind subject" },
    { id: "ai.cinematicGrade", title: "Cinematic color grade" },
    { id: "ai.trackFace", title: "Track face / follow text" },
    { id: "ai.stabilize", title: "Stabilize clip" }
  ];
  for (const command of aiCommands) {
    commandRegistry.register({
      id: command.id,
      title: command.title,
      category: "AI",
      cost: "free",
      // Phase 4 wires this to the AI planner/executor; today it's a discoverable stub.
      run: () => {
        /* wired in Phase 4 */
      }
    });
  }
}
