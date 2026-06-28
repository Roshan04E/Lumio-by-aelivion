import type { BrowserToolCapabilities } from "../../tools/capabilities";
import type { CommandDescriptor } from "./commands";
import type { InspectorPanelProvider } from "./inspector";

/**
 * Module Registry (Phase 3 scaffolding) — the keystone.
 *
 * Every major feature (color, captions, tracking, masking, person cutout, audio
 * cleanup, export, …) registers a lazy descriptor. The shell never imports a
 * feature directly: it discovers capabilities, inspector panels, timeline
 * actions, preview overlays, and commands from the registry. Heavy code is
 * behind `load()` (dynamic import) so it splits out of the main bundle.
 *
 * Existing source-of-truth registries in `packages/shared` (effects, tools,
 * timeline actions) are *described* into modules here — never duplicated.
 */
export type ModuleType = "tool" | "effect" | "panel" | "engine";

export interface PreviewOverlayProvider {
  id: string;
  /** Lazy overlay component (tracker box, motion path, mask outline, …). */
  load: () => Promise<{ default: unknown }>;
}

export interface EditorModule {
  id: string;
  name: string;
  type: ModuleType;
  /** Code-split entry point; called the first time the module is used. */
  load?: () => Promise<unknown>;
  /** Gate the module on detected browser capabilities (reuses `capabilities.ts`). */
  requiredCapabilities?: (keyof BrowserToolCapabilities)[];
  /** Inspector panels this module contributes. */
  inspectorPanels?: InspectorPanelProvider[];
  /** Timeline action ids this module relies on (already in `timelineActionRegistry`). */
  timelineActions?: string[];
  /** Preview overlays this module draws. */
  previewOverlays?: PreviewOverlayProvider[];
  /** Commands (palette + shortcuts) this module contributes. */
  commands?: CommandDescriptor[];
}

export class ModuleRegistry {
  private readonly modules = new Map<string, EditorModule>();
  private readonly loaded = new Map<string, Promise<unknown>>();

  register(module: EditorModule): this {
    if (this.modules.has(module.id)) {
      throw new Error(`Editor module "${module.id}" already registered`);
    }
    this.modules.set(module.id, module);
    return this;
  }

  get(id: string): EditorModule | undefined {
    return this.modules.get(id);
  }

  list(): EditorModule[] {
    return [...this.modules.values()];
  }

  byType(type: ModuleType): EditorModule[] {
    return this.list().filter((module) => module.type === type);
  }

  /** Is this module runnable given the detected browser capabilities? */
  isAvailable(id: string, capabilities: BrowserToolCapabilities): boolean {
    const module = this.modules.get(id);
    if (!module) {
      return false;
    }
    return (module.requiredCapabilities ?? []).every((capability) => capabilities[capability]);
  }

  /** Lazy-load a module once; subsequent calls reuse the in-flight/resolved import. */
  async ensureLoaded(id: string): Promise<unknown> {
    const module = this.modules.get(id);
    if (!module?.load) {
      return undefined;
    }
    const existing = this.loaded.get(id);
    if (existing) {
      return existing;
    }
    const pending = module.load();
    this.loaded.set(id, pending);
    return pending;
  }
}

export const moduleRegistry = new ModuleRegistry();
