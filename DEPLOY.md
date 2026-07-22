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
