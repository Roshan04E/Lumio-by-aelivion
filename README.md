# Orreris Pro

Production-minded MVP for turning normal videos into modular reel-style edits.

Core line: upload a normal video, turn it into a trending reel, preview free, export when satisfied.

## Stack

- pnpm monorepo
- React + Vite + TypeScript frontend in `apps/web`
- Node.js + Express + TypeScript API in `apps/api`
- TypeScript worker in `apps/worker`
- Shared Zod schemas, module catalog, templates, and dependency resolver in `packages/shared`
- Render-template placeholder logic in `packages/render-templates`
- Prisma + PostgreSQL schema and seed data
- Optional Redis/BullMQ worker mode

## Local Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Web: `http://localhost:5173`

API: `http://localhost:4100`

> **Dev vs production-preview origins:** `pnpm --filter @orreris/web build && pnpm --filter @orreris/web preview`
> serves the production bundle on `http://localhost:4173` — a **separate browser-storage universe**
> from `:5173` (its own localStorage, OPFS, IndexedDB, service worker). Ingest proxies, feature
> flags, and local media built on one origin do not exist on the other; the first session on `:4173`
> rebuilds proxies in the background (expected, not a bug). Before trusting any "the fix didn't
> work" repro on `:4173`, compare the console's `index-*.js` hash against the latest build output —
> a stale service worker has served pre-fix bundles before (see `project-tracker/infrastructure.md`).

Demo login used by the frontend:

```text
demo@pesamee.studio
password123
```

## Scripts

```bash
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

`pnpm dev` starts the web app, API, and worker together.

## Architecture

The shared package owns the product vocabulary:

- module types such as `PERSON_EXTRACTION`, `TEXT_BEHIND_PERSON`, `SMART_3D_FOLLOW_TEXT`, `AUTO_CAPTIONS`, and `FINAL_RENDER`
- effect graph types
- Zod request schemas
- seeded template definitions
- wallet packs and MVP limits
- dependency resolver

Templates are not fixed videos. They are reusable module stacks that create editable `ProjectGraph` JSON. The editor and backend both use the same resolver, so adding `SMART_3D_FOLLOW_TEXT` automatically inserts `PERSON_EXTRACTION` and `PERSON_TRACKING` when missing.

## Local AI (Ollama)

Run the AI chat + planner on your **own** local model instead of the cloud pool — private, offline,
unmetered. Because the browser talks to Ollama directly (the server can't reach your `localhost`),
each user just:

1. Installs [Ollama](https://ollama.com) and pulls a model — a vision model lets it read reference
   images, e.g. `ollama pull llama3.2-vision`.
2. Starts it allowing the web origin (CORS): `OLLAMA_ORIGINS=http://localhost:5173 ollama serve`.
3. In the editor's AI panel, clicks **Local** (next to **Pro**), runs **Test connection**, picks the
   model, and enables it.

When Local is on but Ollama is unreachable, the panel offers a 5-second "using cloud" fallback you can
cancel. No server env or API key is involved — see `.env.example`.

## Implemented

- Full monorepo structure with web, api, worker, shared, and render-template packages
- Express API routes for auth, templates, tools, assets, projects, jobs, and payments
- JWT auth with bcrypt password hashing
- Prisma schema for users, templates, tools, assets, derived assets, projects, jobs, payments, and wallet transactions
- Seed data for 8 templates, 5 tools, and 1 demo user
- Local storage service under `apps/api/storage`
- Mock person extraction, tracking data, previews, final exports, and wallet credit debits
- Local AI prompt planner using keyword matching
- Vite frontend routes:
  - `/`
  - `/templates`
  - `/tools`
  - `/cookbook`
  - `/create`
  - `/editor/:projectId`
  - `/checkout/:projectId`
  - `/dashboard`
  - `/admin/templates`
  - `/admin/jobs`
- Mobile-first cinematic UI with a robust desktop editor layout
- Frontend API fallback using local storage when the API or database is not running

## Mocked

- Video upload metadata inspection
- Person extraction masks and cutouts
- Motion tracking data
- Auto captions
- Remotion/FFmpeg rendering
- Payment gateway order and verification
- Worker queue execution by default

## Real Integrations Next

- Replace `mockProcessing.service.ts` with FFmpeg and Remotion render pipelines
- Add MediaPipe or another segmentation/tracking provider for person masks and subject motion
- Move local storage to S3 or Cloudflare R2 through `storage.service.ts`
- Switch `WORKER_QUEUE=bullmq` and push API render requests into Redis/BullMQ
- Replace `aiPlanner.service.ts` with an OpenAI-backed planner that outputs the same `ProjectGraph`
- Replace mock payments with Razorpay or another provider using the existing payment model
- Add signed upload URLs, render webhooks, and project sharing links
