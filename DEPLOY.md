# Deploying Orreris

Single-host production deploy with Docker Compose. Three app images (`web`, `api`, `worker`) plus
Postgres and Redis, wired by [docker-compose.prod.yml](docker-compose.prod.yml).

## Prerequisites

- Docker + Docker Compose v2 on the host.
- A Cloudflare R2 bucket + an S3 API token (Object Read & Write). See [.env.example](.env.example) for
  where to find the endpoint/keys and the bucket CORS policy the browser upload path needs.

## First deploy

```bash
cp .env.prod.example .env.prod          # then edit: JWT_SECRET, POSTGRES_PASSWORD, R2_*, your domain
docker compose -f docker-compose.prod.yml up -d --build
```

Boot order is automatic: Postgres/Redis become healthy → `migrate` applies Prisma migrations and exits →
`api` + `worker` start → `web` starts once `api` is healthy. The site is served on port **80**.

- `WORKER_QUEUE=bullmq` (set in `.env.prod`) makes the API push render jobs to Redis and the worker
  consume them — the production dispatch path.
- `STORAGE_DRIVER=r2` means api and worker exchange media through R2; **no shared filesystem** is needed
  between them (the worker localizes source clips over presigned GETs and reads them locally).

## Updating

```bash
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

New migrations (if any) run via the `migrate` one-shot before api/worker restart.

## Operations

```bash
docker compose -f docker-compose.prod.yml ps                 # status + health
docker compose -f docker-compose.prod.yml logs -f worker     # follow a service
docker compose -f docker-compose.prod.yml run --rm migrate   # re-run migrations manually
```

Health check: `GET /health` on the API returns `{ success: true }`.

## Deploying to Render (managed, via Blueprint)

`render.yaml` provisions everything (Postgres + Redis + api + worker + web) as one Blueprint.

1. Push this repo to GitHub (done).
2. Render → **New → Blueprint** → connect the repo → Render detects `render.yaml`.
3. At the prompt, fill the `sync: false` values: `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY` (from your `.env`), plus any optional keys (Gemini/Pexels/fal). Leave the
   three URL vars (`API_PUBLIC_URL`, `WEB_ORIGIN`, `VITE_API_URL`) blank for now.
4. Apply — Render builds the images (worker/Chromium is the slow one), runs migrations
   (`preDeployCommand`), and starts everything. Note the assigned URLs, e.g.
   `https://orreris-api.onrender.com` and `https://orreris-web.onrender.com`.
5. **Set the URLs** (one-time bootstrap, since the SPA needs the API's address baked in):
   - `orreris-shared` group → `API_PUBLIC_URL` = the api URL.
   - `orreris-api` → `WEB_ORIGIN` = the web URL.
   - `orreris-web` → `VITE_API_URL` = the api URL + `/api`.
   - Redeploy **web** (and api) so the values take effect.
6. Seed the demo login (fresh DB): Render → `orreris-api` → **Shell** →
   `pnpm --filter @orreris/api db:seed`.
7. Open the web URL, log in, export a clip → it renders on the worker. Done.

Updates: push to the deploy branch → Render auto-builds and redeploys.

Cost note: `orreris-worker` is `standard` (~2GB RAM) because headless-Chromium video renders need it;
Postgres/Redis/api can start smaller. There is no free tier for a background worker.

## Managed Postgres / Redis

To use managed services instead of the bundled containers: delete the `postgres` and `redis` services
from the compose file, remove them from each `depends_on`, and point `DATABASE_URL` (add
`?sslmode=require`) and `REDIS_URL` (`rediss://…` for TLS) in `.env.prod` at the managed hosts.

## Split-host (web and api on different domains)

The default is single-host: the web nginx proxies `/api` and `/storage` to the api service, so the SPA
calls its own origin. To split them, build the web image with `VITE_API_URL` set to the API's absolute
URL (compose `web.build.args`), publish the api port, and set `WEB_ORIGIN` to the web domain so CORS
allows it.

## TLS

Terminate HTTPS at a reverse proxy / load balancer in front of `web:80` (or add a TLS-terminating proxy
service). `WEB_ORIGIN` and `API_PUBLIC_URL` must be the public `https://` URLs — `API_PUBLIC_URL` is
baked into stored media URLs.
