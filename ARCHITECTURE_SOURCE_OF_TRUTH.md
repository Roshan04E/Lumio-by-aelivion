# Architecture: where the source of truth lives

**Effective 2026-08-06.**

This repository is **Orreris Pro on the web** — a shipping commercial product with its own roadmap.
It is not a prototype, not a research phase, and not legacy. It ships features, earns revenue,
validates workflows, and discovers what creators actually want. That mission continues unchanged.

**The architectural source of truth for the engine has moved.**

```
C:\Users\rosha\Documents\orreris          ← Orreris Runtime (the engine repository)
```

---

## Which repository owns what

| | **This repository (web)** | **`orreris` (native)** |
|---|---|---|
| **Mission** | ship features, get users, earn revenue | build the media runtime |
| **Answers** | Do creators want this? Is this workflow better? Does ORIS help? Can it earn? | How should playback, scheduling, rendering, memory, and AI-in-the-engine work? |
| **Optimises for** | speed of learning | correctness over a decade |
| **Owns** | product, UX, workflows, the browser implementation | engine architecture, laws, ADRs |

**Knowledge flows web → native. Code flows native → web.**

Lessons travel up from a product meeting real users. Implementation travels down through a shared
pure core. The web product is never asked to wait for the engine, and the engine is never shaped to
mirror a browser constraint. This is BIBLE L15 in the native repository, and it is a law there.

---

## What this means in practice

**New engine-architecture documents are not written here any more.** The `.md` files in this
repository that describe engine architecture — ORIS_*, ORRERIS_OS, FLAREX_*, PREVIEW_PIPELINE,
PLUGIN_ARCHITECTURE, NLE_ANALYSIS, and their relatives — are now **historical design records**.

They are not wrong and they are not deleted. They are frozen: they record what was believed and
learned at the time, and much of what they contain is exactly why the native laws say what they say.
**Do not rewrite them to match the native architecture.** A design record that has been edited to
agree with a later decision has lost the only thing that made it valuable.

**Still live and still maintained here:**

- `architecture.md` — the product/feature tracker (shipped vs deferred vs next)
- `project-tracker/` — append-only problem/solution logs
- `CLAUDE.md` — how to work in this repository
- Anything describing product, UX, or workflow

**Now written in `orreris/` instead:**

- Engine laws and invariants → `BIBLE.md`
- Rendering philosophy → `ORRERIS_RENDERING.md`
- Architecture decisions → `adr/`
- Engine roadmap → `ROADMAP.md`

---

## If you are an agent working in this repository

You are working on **Product A**. Ship things, keep quality high, and keep the pixel gate green.

If you find yourself about to write a document that answers *"how should the engine work"* rather
than *"what should the product do"*, you are in the wrong repository. Record the finding here as a
lesson and let it flow up.

The native repository's laws do not bind this codebase. This codebase's constraints do not bind the
native architecture. That separation is deliberate and it is what keeps both healthy.
