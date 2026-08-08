# Deploying Orreris for $0 (friends-testing setup)

Written 2026-08-09. This is the **free** path — for showing the live app to friends, not for paying
users. The paid path is in `DEPLOY.md`; this file replaces it while money is tight.

Everything here has **no trial clock and no expiry**. Nothing you set up gets deleted in 30 days.

## The stack

| Layer | Service | Free allowance | Note |
|---|---|---|---|
| Database | **Neon** Postgres | 0.5 GB | Use this, NOT Render's free Postgres — that one deletes itself after 30 days. |
| Storage | **Cloudflare R2** | 10 GB + zero egress | Already wired up. Free egress means video playback costs nothing. |
| Web (SPA) | **Render static site** | free | Always up, no cold start. |
| API | **Render web service, Free plan** | 750 hrs/mo | Sleeps after 15 min idle; ~1 min to wake. |
| Job queue | **none** | — | `WORKER_QUEUE=mock` makes jobs go through Postgres instead of Redis. |
| Renders | **your own laptop** | — | The worker polls the DB and pushes to R2. It accepts no inbound connections, so it can run anywhere. |

**Do NOT use the Blueprint (`render.yaml`) for this.** It provisions Postgres, Redis and a paid worker —
all three of which this setup drops. Create the two Render services by hand instead. It's less work.

## Steps

### 1. Neon

Create a project. Copy the connection string and append `?sslmode=require`.

### 2. Schema + login, from your laptop

The Free plan has no pre-deploy command and no shell, so these two run locally instead. Same result.

```bash
DATABASE_URL="<neon-url>" pnpm --filter @orreris/api prisma:deploy
DATABASE_URL="<neon-url>" pnpm --filter @orreris/api db:seed
```

### 3. Render → New → **Web Service** (the API)

- Branch: `method-3-gpu-compositor` (NOT `main` — main is still the initial commit)
- Runtime: **Docker**, Dockerfile path `apps/api/Dockerfile`, Docker context `.`
- Plan: **Free**
- Health check path: `/health`
- Environment variables:

```
DATABASE_URL          = <neon-url>
NODE_ENV              = production
WORKER_QUEUE          = mock
STORAGE_DRIVER        = r2
JWT_SECRET            = <generate a long random string yourself>
R2_ENDPOINT           = ...
R2_BUCKET             = ...
R2_ACCESS_KEY_ID      = ...
R2_SECRET_ACCESS_KEY  = ...
R2_PUBLIC_BASE_URL    = ...
```

(The R2 values are in your local `.env`.) Leave `API_PUBLIC_URL` and `WEB_ORIGIN` for step 5.

### 4. Render → New → **Static Site** (the editor)

- Same branch.
- Build command:
  ```
  corepack enable && corepack prepare pnpm@11.5.1 --activate && pnpm install --frozen-lockfile && pnpm --filter @orreris/web build
  ```
- Publish directory: `apps/web/dist`
- Leave `VITE_API_URL` for step 5.

### 5. Fill in the three URLs

They don't exist until the first deploy assigns them. This is the step people forget.

- API service → `API_PUBLIC_URL` = the API's https URL
- API service → `WEB_ORIGIN` = the static site's https URL
- Static site → `VITE_API_URL` = the API's https URL **+ `/api`**

Then **redeploy the static site** so the value is baked into the build.

### 6. Exports — run the worker on your laptop

Only needed when you actually want to export. Jobs queued while it's off just wait in Postgres.

```bash
DATABASE_URL="<neon-url>" STORAGE_DRIVER=r2 \
R2_ENDPOINT=... R2_BUCKET=... R2_ACCESS_KEY_ID=... \
R2_SECRET_ACCESS_KEY=... R2_PUBLIC_BASE_URL=... \
pnpm --filter @orreris/worker start
```

## What you're accepting

- First request after 15 idle minutes takes about a minute. Your friends hit this every session.
- No shell on the Free API — future database work runs from your laptop, as in step 2.
- Exports only finish while your laptop is on and step 6 is running. Nothing is lost otherwise; the job
  waits.
- Neon also sleeps, but wakes in under a second — invisible behind the API's own cold start.
- 10 GB of R2 is a few dozen exports. Delete test videos now and then.

## Known bug, unfixed at time of writing

A transient GPU failure during export can produce a **blank white frame**, and the render still reports
success (`SceneStage.tsx` reports a failed composite as a completed frame). Registered as DEBT-015. It is
rare and it is more likely under memory pressure — so while the worker runs on your laptop, avoid
exporting with 30 Chrome tabs open, and glance at the render log for `composite failed`.

## Upgrading later (~$12/mo)

Both are a plan change and a redeploy. Nothing built above is thrown away.

- **API → Render Starter, $7.** Buys migrations-on-deploy (`preDeployCommand`), shell access, and no cold
  start. Do this before any real user sees the site.
- **Worker → Hetzner CX22, ~€4.49/mo.** 2 vCPU / 4 GB, x86, runs `apps/worker/Dockerfile` unchanged —
  double Render Standard's RAM at a fifth of the price.
- Oracle Cloud's Always Free ARM tier is a genuine $0 alternative for the worker (Remotion supports
  linux-arm64; only AV1 is unavailable and you output h264). But: the tier was halved to 2 OCPU / 12 GB in
  June 2026, idle instances can be reclaimed, and ARM capacity is often unavailable. Fine for a hobby box,
  risky for the thing that renders customer videos.
