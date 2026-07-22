# syntax=docker/dockerfile:1
# Orreris API. Build from the REPO ROOT (the app imports workspace:* packages):
#   docker build -f apps/api/Dockerfile -t orreris-api .
# The API runs its TypeScript directly via tsx (its real `start` script) — there is NO compile step;
# it only needs the workspace deps installed and the Prisma client generated for Linux.
FROM node:24-bookworm-slim AS runtime

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate

# Prisma's query engine links against OpenSSL, and node:24-bookworm-slim ships WITHOUT it — without
# this, `prisma generate` / the engine postinstall warn "Please install openssl" and the client can
# fail to load at runtime. ca-certificates lets the engine download + HTTPS calls validate.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Whole workspace: apps depend on the workspace:* packages and are executed from source by tsx.
# node_modules / dist / secrets are pruned by .dockerignore.
COPY . .

# Install every workspace's deps. tsx is a devDependency but is REQUIRED to run in prod, so we do
# NOT prune to --prod. --frozen-lockfile fails the build if the lockfile is out of date.
RUN pnpm install --frozen-lockfile

# Generate the Prisma client with the Linux query engine. The schema pins no binaryTargets, so
# `native` resolves to this Debian image's engine (correct because this RUN executes on Linux).
RUN pnpm --filter @orreris/api prisma:generate

EXPOSE 4100
# DB schema is applied as a SEPARATE release step (e.g. `prisma migrate deploy`), not on container
# start, so replicas don't race to migrate. Set DATABASE_URL / REDIS_URL / JWT_SECRET / WEB_ORIGIN /
# API_PUBLIC_URL / STORAGE_DRIVER + R2_* / WORKER_QUEUE at runtime.
CMD ["pnpm", "--filter", "@orreris/api", "start"]
