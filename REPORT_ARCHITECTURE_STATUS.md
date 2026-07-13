# Kimera Architecture Status Report

**Generated:** 2026-07-06  
**Project:** Kimera (trendcut) - Browser-first video editor for short-form creators  
**Current Branch:** `method-3-gpu-compositor`

---

## Executive Summary

Kimera has completed its foundational GPU-rendered preview architecture (Method 3), a professional color system, and many AI tooling capabilities. The codebase shows strong technical maturity with a focus on pixel-identical rendering across preview, local export, and cloud export paths.

**Status:** Production-ready foundation with AI capabilities in use, remaining work primarily focused on export path completion, advanced AI features, and some cleanup tasks.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Kimera Application Stack                             │
├─────────────────────────────────────────────────────────────────────────────┤
│ apps/web         - React/Vite editor + tool pages                          │
│ apps/api         - Express + Prisma/Postgres, JWT auth                     │
│ apps/worker      - Remotion render pipeline + BullMQ queue                 │
│ packages/shared  - Product vocabulary (types, effects, masks, captions)    │
│ packages/render-templates - Render template placeholder logic               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## What Has Shipped

### 1. Core Rendering Foundation - METHOD 3 (GPU Compositor) ✅ COMPLETE

**What it is:** A unified GPU-based rendering engine that produces pixel-identical output across all three render paths (web preview, local export, cloud export).

**Status:** Fully shipped and running by default.

| Component | Status | Details |
|-----------|--------|---------|
| `SceneCompositor` | ✅ | WebGL2 context, ping-pong RTT accumulator, 16 blend modes in-shader |
| `MediaWebGLRenderer` | ✅ | Unified image+video grading, single GPU pass for color + matte + opacity |
| Region effects pass model | ✅ | Per-effect masked post-composite passes (AE model) |
| Transitions | ✅ | Clip groups (full effects baked) mixed via GPU shader |
| Text/Shape rasterization | ✅ | Into the composite pass, no DOM fallback |
| Local export | ✅ | Worker `SceneFrameCompositor` → main-thread fallback |
| Remotion/cloud | ✅ | `SceneStage` with shared `buildSceneDraws` |

**Gates passed:** `scene:compare` 22/22, `render:compare:pixels` 23/23 @ 0.000%

### 2. Professional Color System (Premiere Lumetri-class) ✅ COMPLETE

**What it is:** A real color pipeline with curves, color wheels, HSL secondaries, LUTs, and scopes that grades in Rec.709 linear light.

**Status:** 13C.0 through 13C.8 and E1-E3 all complete.

| Component | Status |
|-----------|--------|
| SVG filter engine | ✅ Shared engine for DOM path |
| WebGL/3D-LUT engine | ✅ Default path (shared by both renderers) |
| Basic Correction (exposure, contrast, WB, tone) | ✅ |
| Curves (master + R/G/B + HSL) | ✅ |
| Color Wheels (Lift/Gamma/Gain via ASC-CDL) | ✅ |
| HSL Secondary keyer | ✅ |
| LUT import (.cube) + Creative Looks | ✅ |
| Color scopes (Waveform, RGB Parade, Vectorscope, Histogram) | ✅ |
| Managed linear pipeline | ✅ Rec.709-linear working space |
| Export color tagging (BT.709) | ✅ |
| Real source color detection (mp4box colr) | ✅ |
| Vignette, Grain, Chroma Key | ✅ Native shaders |

### 3. AI Tooling Infrastructure ✅ COMPLETE

**What it is:** A framework for AI-powered video tools with two usage paths:
1. **Free Prompt Bridge:** Generate prompt → user pastes result back → apply
2. **Integrated AI:** Chat → tool selection → execute → apply

**Status:** Core infrastructure complete, multiple tools in use.

| Component | Status |
|-----------|--------|
| Tool capability registry | ✅ |
| `PERSON_EXTRACTION` (MediaPipe RVM) | ✅ Browser adapter |
| `AUTO_CAPTIONS` | ✅ Browser adapter |
| `TEXT_BEHIND_PERSON` | ✅ |
| `SMART_3D_FOLLOW_TEXT` | ✅ |
| `BACKGROUND_REMOVAL` | ✅ |
| `PERSON_REMOVAL` (LaMa inpainting) | ✅ |
| AI Planner (Deterministic + LLM) | ✅ |
| Capability discovery + cost classification | ✅ |
| Confidence + permission modes (quick/professional/agent) | ✅ |
| BYO-key (BYO OpenAI/Gemini/Claude) | ✅ |
| Local mode (Ollama) | ✅ |
| Premium Claude (gated "Best Quality") | ✅ |
| Interactive clarify loop | ✅ |
| AI memory/prefs persistence | ✅ |

### 4. Timeline Editing Primitives ✅ COMPLETE

| Feature | Status | Notes |
|---------|--------|-------|
| Trim (slip/ripple/roll/slide) | ✅ | Premiere semantics |
| Speed ramps (time remap) | ✅ | Linear segments, exact integral mapping |
| Clip audio FX (EQ/Compressor/Gate/Limiter) | ✅ | AudioWorklet, same DSP everywhere |
| Auto-ducking | ✅ | RMS-based sidechain analysis |
| Audio track mixer (faders + pan) | ✅ | Post-mix in worker when pan non-zero |
| Paste attributes (Ctrl+Alt+C/V) | ✅ | Effects/transform/fit |
| Effect presets | ✅ | localStorage |
| Replace asset | ✅ | Swap media without changing timeline |
| Slip mode (double-click drag) | ✅ | Source in-point changes |
| Nesting/Compound clips | ✅ | Import Premiere .prproj or native |
| Markers (named + colored) | ✅ | 8-color palette |

### 5. Preview & Playback Stability ✅ COMPLETE

| Feature | Status | Notes |
|---------|--------|-------|
| Adaptive proxy cache (OPFS) | ✅ | Export-grade, content-signature invalidation |
| GPU context governor | ✅ | Default ON, LRU eviction, hard cap 4 |
| GPU recovery | ✅ | Auto-rebuild on context loss |
| WebCodecs decoder pool | ✅ | Default ON, pooled sessions with prioritization |
| Audio master playback clock | ✅ | Syncs all layers to earliest advancing audio |
| Frame telemetry | ✅ | FPS, dropped %, composite ms |
| Reverse-shuttle cache | ✅ | Byte-capped VideoFrame cache |
| Streaming demux | ✅ | ≤24MB working window, peak RAM = one GOP |

### 6. Export Pipeline ✅

| Component | Status | Notes |
|-----------|--------|-------|
| Local export (WebCodecs) | ✅ | Worker SceneFrameCompositor, main-thread fallback |
| Cloud export (Remotion) | ✅ | BT.709 tagged, parallel-encoding disabled |
| Frame comparison test | ✅ | `render:compare:pixels` |
| Manifest download | ✅ | For local debugging |
| Proxy-captures-viewer | ✅ | Preview compositor → proxy |

### 7. Effects & Transitions ✅

| Component | Status |
|-----------|--------|
| Shared effect registry | ✅ Schema-driven |
| 30+ built-in effects | ✅ |
| Unified GPU transition engine | ✅ Two-texture fragment shaders |
| 40+ built-in transitions | ✅ |
| Effect reorder | ✅ |
| Transition order | ✅ |

### 8. Masking & Rotoscoping ✅

| Component | Status |
|-----------|--------|
| Vector masks (rect/ellipse/polygon/pen) | ✅ |
| Clip masks + effect-region masks | ✅ |
| Modes (Add/Subtract/Intersect/Exclude) | ✅ |
| Feather, Expansion, Opacity | ✅ |
| Invert | ✅ |
| Shape keyframes | ✅ |
| Scalar prop keyframes | ✅ |
| Mask tracking (attach saved motion track) | ✅ |

### 9. Media Library ✅

| Component | Status |
|-----------|--------|
| Local/AI/Stock/Brand tabs | ✅ |
| SourceAsset unified metadata | ✅ |
| Source color detection + persistence | ✅ |
| Proxy-captures-viewer (export-grade proxies) | ✅ |
| Stock import (Pexels/Pixabay) | ✅ |
| Cloud upload option | ✅ |
| Filmstrip/poster extraction | ✅ |
| Audio peaks decode | ✅ |

### 10. AI Operating System ✅

| Component | Status |
|-----------|--------|
| Timeline Action Registry | ✅ 24+ actions |
| Capability discovery + cost | ✅ |
| Interactive tools (pause on input) | ✅ |
| Conversational refinement | ✅ |
| LLM planner seam (OpenAI-compatible) | ✅ |
| Provider gateway with failover | ✅ Cerebras→Groq→OpenRouter→Gemini→Claude |

### 11. Plugin Architecture ✅

| Component | Status |
|-----------|--------|
| Plugin manifest contract | ✅ `.kimera` packages |
| Effect providers | ✅ Built-in + manifest |
| Transition providers | ✅ |
| Looks providers | ✅ |
| Template providers | ✅ |
| `.cube` LUT import | ✅ |
| GLSL transition import | ✅ |
| External timeline import (EDL/FCPXML/XML/prproj) | ✅ |
| Plugin safety validation | ✅ |
| Backend catalog | ✅ |

---

## What Remains (Gaps & Deferred Work)

### P1 - Preview Stability Refinements (Minor Cleanup)

**Priority:** Low  
**Estimated Effort:** 1-2 days

| Gap | Status | Notes |
|-----|--------|-------|
| Explicit backward-seek renderer dedup | ✅ Deferred | Bounded by mount filter + hard cap |
| Region-effect cleanup (retire expansion sites) | ✅ Deferred | Wait for soak, DOM fallback still needs expansion |

### P2 - Export Path Completion

**Priority:** Medium  
**Estimated Effort:** 3-5 days

| Gap | Status | Notes |
|-----|--------|-------|
| Browser export renderer (not built) | ❌ | Plan exists but no implementation |
| Local desktop renderer (not built) | ❌ | Plan exists but no implementation |
| Server-side matte resolution | ❌ | OPFS matte URIs browser-local, need fetchable URLs for Remotion |

### P3 - AI Tool Coherence

**Priority:** Medium  
**Estimated Effort:** 2-4 days

| Gap | Status | Notes |
|-----|--------|-------|
| Cross-tool artifact reuse | ❌ | Extract person → reuse mask in Text Behind Person/Remove Background |
| Extract Person adapter reconciliation | ❌ | Tool page bypasses `tool-runner.ts` adapter dispatch |
| Cloud segmentation adapter | ❌ | Contract-only stub |
| SAM2 point-prompt + tracking | ❌ | Remove Person currently static brush only |
| Cloud SAM2 + inpainting | ❌ | Contract-only stub |

### P4 - Deferred AI Capabilities

**Priority:** Low  
**Estimated Effort:** 2-6 weeks (estimated)

| Capability | Status | Notes |
|-----------|--------|-------|
| Scene Detection | ❌ | Named but unbuilt |
| Speed Ramp (AI) | ❌ | Named but unbuilt |
| Auto-Reframe | ❌ | Named but unbuilt |
| Motion Blur | ❌ | Named but unbuilt |
| Professional Person/BG Removal | ❌ | Named but unbuilt |
| Runner registration for modals | ❌ | Some modals can't run yet |

### P5 - Editor Refactor

**Priority:** Low  
**Estimated Effort:** 2-3 weeks

| Phase | Status | Notes |
|-------|--------|-------|
| EditorPage migration to Zustand | ❌ | 5.2k LOC |
| ToolDetailPage migration | ❌ | 2.8k LOC |
| Inspector registry (Zustand-backed) | ❌ | Partially done |

### P6 - Effect Presets

| Gap | Status | Notes |
|-----|--------|-------|
| Save/load effect presets | ❌ | UI exists for save, load needs implementation |

### P7 - Transitions

| Gap | Status | Notes |
|-----|--------|-------|
| Per-clip transform during transition | ❌ | Scale/position/rotation keyframes not applied in transition window |

### P8 - Renderer Sandboxes (Plugin Execution)

| Gap | Status | Notes |
|-----|--------|-------|
| `webgl-fragment` execution sandbox | ❌ | Deferred pending sandbox |
| `css-filter` execution sandbox | ❌ | Deferred pending sandbox |
| `composite` execution sandbox | ❌ | Deferred pending sandbox |

---

## Architecture Strengths

1. **Pixel-identical rendering** across preview, local export, and cloud export through shared composition models
2. **GPU-first design** with WebGL2 and proper context management
3. **Two-tier AI support** - free prompt bridge and integrated AI both first-class
4. **Plugin-ready architecture** - effects, transitions, looks all provider-based
5. **Professional color pipeline** - matching Premiere Lumetri capabilities
6. **Comprehensive test infrastructure** - `render:compare:pixels`, `color:compare`, `scene:compare` gates
7. **Stable proxy system** - export-grade proxies with content-signature invalidation
8. **AI operating system** - deterministic planner + LLM failover + BYO-key

---

## Current Development Focus

Based on the current branch (`method-3-gpu-compositor`) and architecture.md:

1. **Method 3 cleanup** - retiring old DOM/clone code paths
2. **Server-side matte resolution** - enabling masked layers to export via Remotion
3. **AI tool coherence** - cross-tool mask reuse
4. **Export path completion** - browser/local desktop renderers

---

## Testing Infrastructure

| Gate | Status | Command |
|------|--------|---------|
| `governor:test` | ✅ | Context eviction stress |
| `color:test` | ✅ | 60 checks |
| `scene:compare` | ✅ | 22/22 fixtures |
| `render:compare:pixels` | ✅ | 23/23 @ 0.000% |
| `animation:test` | ✅ | Keyframe/animation evaluator |
| `editor:test` | ✅ | 148 checks |
| `actions:test` | ✅ | Timeline action registry |

---

## Conclusion

Kimera has a **production-grade foundation** with most critical path items complete. The remaining work falls into:

- **Cleanup tasks** (deferred items that can wait)
- **Export path expansion** (browser/local desktop renderers)
- **AI tool completeness** (cross-tool reuse, cloud adapters)
- **Editor infrastructure modernization** (Zustand migration)

The architecture is solid, well-tested, and ready for production use. The remaining work is primarily extensions and polish rather than foundational changes.

---

## Quick Reference: How to Verify Current State

```bash
# Typecheck (lint)
pnpm typecheck

# Run all fixtures in GPU environment (requires PIXEL_BROWSER_CHANNEL=chrome)
PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @kimera-by-aelivion/worker render:compare:pixels
PIXEL_BROWSER_CHANNEL=chrome pnpm --filter @kimera-by-aelivion/worker scene:compare

# Test context governor
pnpm --filter @kimera-by-aelivion/shared governor:test

# Render manifest to MP4 (manual verification)
pnpm --filter @kimera-by-aelivion/worker render:manifest <manifest.json>

# Editor tests
pnpm --filter @kimera-by-aelivion/web editor:test
```

---

*This report was generated from architecture.md, GAPS.md, COLOR_SYSTEM_PLAN.md, MASKS.md, PLUGIN_ARCHITECTURE.md, and the current state of the codebase.*
