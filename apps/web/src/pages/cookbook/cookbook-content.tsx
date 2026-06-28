import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  dependencyRules,
  moduleCatalog,
  stageLabel,
  timelineEffectRegistry,
  toolCapabilityDefinitions,
  type EffectModule,
  type ModuleType,
  type ToolCapabilityDefinition
} from "@reelforge/shared";
import {
  BookOpen,
  Boxes,
  GitBranch,
  Layers,
  Route,
  Sparkles,
  Wrench,
  type LucideIcon
} from "lucide-react";

/**
 * The cookbook is the in-app, fully-transparent guide. Its hard rule: every
 * factual claim about a tool/module/effect is rendered from the same shared
 * registry the real app uses (toolCapabilityDefinitions, moduleCatalog,
 * dependencyRules, timelineEffectRegistry), so the docs can never quietly drift
 * from the product. Only the narrative prose around those facts is written here.
 */

export interface CookbookSubsection {
  id: string;
  title: string;
  descriptor: string;
  render: () => ReactNode;
}

export interface CookbookSection {
  id: string;
  title: string;
  blurb: string;
  icon: LucideIcon;
  subsections: CookbookSubsection[];
}

// --- Small presentational primitives (kept local to the cookbook) ----------

function UnderTheHood({ children }: { children: ReactNode }) {
  return (
    <aside className="cookbook-callout">
      <span className="cookbook-callout-label">Under the hood 🔧</span>
      <div>{children}</div>
    </aside>
  );
}

function Diagram({ children }: { children: ReactNode }) {
  return <pre className="cookbook-diagram">{children}</pre>;
}

function statusTone(status: EffectModule["status"]): "lime" | "muted" | "success" {
  if (status === "available") return "success";
  if (status === "experimental") return "lime";
  return "muted";
}

function browserModeCopy(mode: ToolCapabilityDefinition["browserMode"]): string {
  switch (mode) {
    case "instant":
      return "Runs instantly in your browser — no heavy compute.";
    case "progressive":
      return "Runs in your browser, streaming results progressively.";
    case "heavy":
      return "Heavy in-browser ML — fast preview first, full quality on demand.";
  }
}

// --- Tool card, generated entirely from the live registry ------------------

function ToolCard({ tool }: { tool: ToolCapabilityDefinition }) {
  return (
    <div className="cookbook-tool">
      <div className="cookbook-tool-head">
        <h3>{tool.name}</h3>
        <span className="cookbook-tool-tags">
          <em>{tool.category}</em>
          <em>{tool.browserMode}</em>
          <em>{tool.estimatedCredits ?? 0} cr</em>
        </span>
      </div>
      <p className="cookbook-tool-lede">{tool.userDescription}</p>

      <div className="cookbook-tool-grid">
        <div>
          <h4>Takes in</h4>
          <p>{tool.accepts.join(", ")}</p>
        </div>
        <div>
          <h4>Gives back</h4>
          <p>{tool.outputs.join(", ")}</p>
        </div>
        <div>
          <h4>Best for</h4>
          <p>{tool.bestFor}</p>
        </div>
        <div>
          <h4>Runs where</h4>
          <p>{tool.adapters.join(" · ")}</p>
        </div>
      </div>

      <div className="cookbook-tool-stages">
        {tool.stages.map((stage, index) => (
          <span key={stage}>
            {index > 0 ? <i aria-hidden>→</i> : null}
            {stageLabel(stage)}
          </span>
        ))}
      </div>

      <UnderTheHood>
        <p>{tool.aiDescription}</p>
        <p className="cookbook-muted">{browserModeCopy(tool.browserMode)}</p>
      </UnderTheHood>

      {tool.limitations.length ? (
        <details className="cookbook-tool-limits">
          <summary>Honest limitations ({tool.limitations.length})</summary>
          <ul>
            {tool.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </details>
      ) : null}

      <Link className="cookbook-tool-open" to={`/tools/${tool.slug}`}>
        Open {tool.name} →
      </Link>
    </div>
  );
}

// --- Sections --------------------------------------------------------------

export const cookbookSections: CookbookSection[] = [
  {
    id: "overview",
    title: "What ReelForge is",
    blurb: "The pitch, the people it's built for, and the one belief everything else follows from.",
    icon: BookOpen,
    subsections: [
      {
        id: "pitch",
        title: "A browser-first reel studio",
        descriptor: "Upload a normal clip, leave with a trending reel.",
        render: () => (
          <>
            <p>
              ReelForge turns a normal video into a short-form reel, entirely in your browser. Upload a clip, shape it on a
              real timeline, preview it for free, and export only when you're happy. No install, no upload-and-pray —
              the editing happens on your machine, in the open.
            </p>
            <p>
              It's meant to feel simple for a first-time creator, but familiar enough that someone coming from Premiere Pro or
              After Effects finds the tools they expect: tracks, keyframes, effects, a graph editor, and a viewer that tells
              the truth about your export.
            </p>
          </>
        )
      },
      {
        id: "who",
        title: "Who it's for",
        descriptor: "Students, budget creators, editors leaving heavy desktop apps, and pros.",
        render: () => (
          <ul className="cookbook-people">
            <li>
              <strong>Students &amp; budget creators</strong> — who can't pay for a stack of AI subscriptions but still want
              modern, trend-ready edits.
            </li>
            <li>
              <strong>Premiere / After Effects refugees</strong> — who want timeline + keyframe muscle memory without a
              multi-gigabyte install.
            </li>
            <li>
              <strong>Pros &amp; power users</strong> — who need clean, high-quality output (real mattes, parity between
              preview and export) for client work.
            </li>
          </ul>
        )
      },
      {
        id: "belief",
        title: "The one belief",
        descriptor: "Everything stays editable and everything is open.",
        render: () => (
          <>
            <p>
              Whatever produces a result — a free prompt you paste into your own chat AI, an integrated AI call, or a tool you
              run by hand — the output always lands as <strong>editable timeline data</strong>. Nothing is baked, locked, or
              hidden behind a black box. This cookbook exists because the product is transparent on purpose: you should be able
              to read exactly how each tool works.
            </p>
            <UnderTheHood>
              <p>
                Credits are metadata only right now — there's no paywall gating, no subscription dependency, and no hard credit
                blocker stopping you from editing. That's a deliberate product stance, not a missing feature.
              </p>
            </UnderTheHood>
          </>
        )
      }
    ]
  },
  {
    id: "two-paths",
    title: "Two ways to use it",
    blurb: "A free path that uses your own chat AI, and an integrated path — same result either way.",
    icon: Route,
    subsections: [
      {
        id: "paths",
        title: "Free prompt bridge vs integrated AI",
        descriptor: "Same tool capabilities, two front doors.",
        render: () => (
          <>
            <p>
              Every AI tool supports two realities. Both run through the <em>same</em> capability registry and both produce the
              same editable timeline data — the only difference is who does the AI step.
            </p>
            <div className="cookbook-paths">
              <div>
                <h4>Free prompt bridge</h4>
                <Diagram>{`open a tool
  → ReelForge writes a precise prompt
  → you paste it into your own chat AI
  → paste the result back
  → ReelForge validates + applies it`}</Diagram>
                <p className="cookbook-muted">For anyone who already has a free chat tool and doesn't want to pay for integrated AI.</p>
              </div>
              <div>
                <h4>Integrated AI</h4>
                <Diagram>{`ask ReelForge chat
  → AI picks a tool
  → fills the params
  → you confirm
  → it runs and becomes timeline data`}</Diagram>
                <p className="cookbook-muted">For anyone who wants convenience and higher limits in one place.</p>
              </div>
            </div>
          </>
        )
      }
    ]
  },
  {
    id: "flow",
    title: "How a reel flows",
    blurb: "From raw asset to exported MP4, and the contract that keeps preview honest.",
    icon: GitBranch,
    subsections: [
      {
        id: "pipeline",
        title: "The pipeline",
        descriptor: "Assets → timeline → graph → manifest → renderers.",
        render: () => (
          <>
            <p>Your media moves through a fixed, inspectable pipeline:</p>
            <Diagram>{`Assets ─▶ Timeline ─▶ Project Graph ─▶ Render Manifest ─┬─▶ Web preview
                                                       ├─▶ Browser export
                                                       ├─▶ Local desktop render
                                                       └─▶ Cloud worker render`}</Diagram>
            <p>
              The <strong>render manifest</strong> is the product contract. Every renderer — the live preview in your editor,
              the exported video, and future local/cloud renderers — consumes the <em>same</em> deterministic manifest. That's
              what makes "what you see is what you export" a guarantee rather than a hope.
            </p>
          </>
        )
      },
      {
        id: "parity",
        title: "Why preview equals export",
        descriptor: "A real bug story about keeping the two renderers honest.",
        render: () => (
          <>
            <p>
              Two renderers draw your reel: a browser one for the editor preview, and Remotion for the final MP4. If they ever
              disagree, you can't trust the preview. So they share the same composition data and the same math.
            </p>
            <UnderTheHood>
              <p>
                A real example from this codebase: the Remotion renderer once had a hardcoded entrance "spring" that scaled
                every text and shape layer up from small to full size over the first ~0.4s. The manifest was clean, the preview
                was flat — but every exported video zoomed. The fix was deleting that renderer-only animation so both sides draw
                exactly what the manifest says. There's now a pixel-comparison test between the two renderers to keep them
                aligned. That's the standard the whole pipeline is held to.
              </p>
            </UnderTheHood>
          </>
        )
      }
    ]
  },
  {
    id: "toolbox",
    title: "The toolbox",
    blurb: "Every creator tool, what it does for you, and how it actually works — straight from the registry.",
    icon: Wrench,
    subsections: [
      {
        id: "tools",
        title: "Every tool, in the open",
        descriptor: "Cards generated live from the capability registry.",
        render: () => (
          <>
            <p>
              These cards are rendered from the same <code>toolCapabilityDefinitions</code> registry the app runs on — the
              inputs, outputs, stages, adapters, and limitations you see here are the real ones, not marketing copy.
            </p>
            <div className="cookbook-tool-list">
              {toolCapabilityDefinitions.map((tool) => (
                <ToolCard key={tool.id} tool={tool} />
              ))}
            </div>
          </>
        )
      },
      {
        id: "extract-person",
        title: "Deep dive: Extract Person",
        descriptor: "The tiered matting engine and the matte that survives to export.",
        render: () => (
          <>
            <p>
              Extract Person is the most involved tool, so it's worth opening up. It separates the main person from the
              background and produces a reusable <strong>matte</strong> (an alpha cutout) that other tools — Remove Background,
              Text Behind Person, Follow Text — can build on.
            </p>
            <h4>A tiered engine, chosen for your device</h4>
            <ul className="cookbook-people">
              <li>
                <strong>Fast preview</strong> — a small MediaPipe segmentation model (the same family that powers Google Meet's
                background blur). Real-time, runs on any device, gives you an instantly usable cutout.
              </li>
              <li>
                <strong>High-quality bake</strong> — Robust Video Matting (RVM) via ONNX Runtime, which carries memory across
                frames so edges stay stable instead of flickering. It uses WebGPU when your device has it and falls back to CPU
                when it doesn't — slower, but still correct.
              </li>
            </ul>
            <UnderTheHood>
              <p>
                The matte is baked to a grayscale luma-matte video, and a single shared compositing function multiplies it into
                the clip's alpha. Both the editor preview and the Remotion export call that <em>same</em> function — so the
                cutout you tune is pixel-identical to the one you export. The high-quality bake is gated behind a clear warning
                because it's genuinely resource-heavy.
              </p>
            </UnderTheHood>
          </>
        )
      }
    ]
  },
  {
    id: "effects",
    title: "Effects & keyframes",
    blurb: "The effect catalog and how animation is evaluated the same way everywhere.",
    icon: Sparkles,
    subsections: [
      {
        id: "effect-table",
        title: "The effect catalog",
        descriptor: "Every effect, its category, and where it renders.",
        render: () => (
          <table className="cookbook-table">
            <thead>
              <tr>
                <th>Effect</th>
                <th>Category</th>
                <th>Preview</th>
                <th>Export</th>
                <th>Params</th>
              </tr>
            </thead>
            <tbody>
              {timelineEffectRegistry.map((effect) => (
                <tr key={effect.type}>
                  <td>
                    <strong>{effect.name}</strong>
                    <span className="cookbook-muted">{effect.description}</span>
                  </td>
                  <td>{effect.category}</td>
                  <td>{effect.previewSupport}</td>
                  <td>{effect.renderSupport}</td>
                  <td>{effect.params.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      },
      {
        id: "keyframes",
        title: "One animation evaluator",
        descriptor: "Why your keyframes look the same in preview and export.",
        render: () => (
          <>
            <p>
              Effect parameters and transforms can be keyframed, with a graph editor and temporal Bézier handles for fine
              control. Just like the renderers, animation is evaluated by a single shared evaluator — the editor and the
              exporter interpolate keyframes with identical math, so motion never drifts between what you tune and what you ship.
            </p>
          </>
        )
      }
    ]
  },
  {
    id: "modules",
    title: "Modules & dependencies",
    blurb: "The building blocks behind the tools, and the resolver that wires them up for you.",
    icon: Boxes,
    subsections: [
      {
        id: "module-list",
        title: "The module catalog",
        descriptor: "The lower-level effect modules tools are built from.",
        render: () => (
          <div className="cookbook-module-grid">
            {moduleCatalog.map((module) => (
              <div className="cookbook-module" key={module.id}>
                <div className="cookbook-module-head">
                  <h4>{module.name}</h4>
                  <span className={`badge badge-${statusTone(module.status)}`}>{module.status}</span>
                </div>
                <p>{module.description}</p>
                <p className="cookbook-muted">
                  {module.inputTypes.join(", ")} → {module.outputTypes.join(", ")}
                </p>
              </div>
            ))}
          </div>
        )
      },
      {
        id: "dependency-graph",
        title: "The dependency resolver",
        descriptor: "Adding one module quietly pulls in what it needs.",
        render: () => {
          const rules = Object.entries(dependencyRules).filter(
            ([, deps]) => Array.isArray(deps) && deps.length > 0
          ) as Array<[ModuleType, ModuleType[]]>;
          return (
            <>
              <p>
                Templates aren't locked videos — they're stacks of modules. When you add one that needs others, the resolver
                inserts the prerequisites automatically, so you never end up with a half-wired effect graph.
              </p>
              <Diagram>
                {rules.map(([type, deps]) => `add ${type}\n   ↳ also inserts ${deps.join(", ")}`).join("\n\n")}
              </Diagram>
            </>
          );
        }
      }
    ]
  },
  {
    id: "glossary",
    title: "Glossary",
    blurb: "Plain-language definitions for the words the rest of this guide uses.",
    icon: Layers,
    subsections: [
      {
        id: "terms",
        title: "Terms, decoded",
        descriptor: "Matte, manifest, adapter, artifact, and friends.",
        render: () => (
          <dl className="cookbook-glossary">
            <dt>Matte</dt>
            <dd>A grayscale cutout that says which pixels are the person (keep) and which are background (drop).</dd>
            <dt>Luma matte</dt>
            <dd>A matte stored as a video where brightness = keep amount — white keeps, black drops.</dd>
            <dt>Render manifest</dt>
            <dd>The deterministic description of your reel that every renderer reads. The "source of truth" for export.</dd>
            <dt>Project graph</dt>
            <dd>The editable data behind a project — its tracks, layers, effects, and module stack.</dd>
            <dt>Adapter</dt>
            <dd>Where a tool actually runs: mock (instant placeholder), browser (on your device), cloud, or desktop.</dd>
            <dt>Artifact</dt>
            <dd>A reusable output a tool produces — a transcript, a mask sequence, a tracking path — that other tools can consume.</dd>
            <dt>OPFS</dt>
            <dd>Origin Private File System — private browser storage where generated artifacts are cached on your machine.</dd>
          </dl>
        )
      }
    ]
  }
];

export function getCookbookSection(id: string | undefined): CookbookSection | undefined {
  return cookbookSections.find((section) => section.id === id);
}

export const defaultCookbookSectionId = cookbookSections[0]!.id;
