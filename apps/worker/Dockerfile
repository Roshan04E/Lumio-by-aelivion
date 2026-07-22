# syntax=docker/dockerfile:1
# Orreris render worker (Remotion + headless Chromium). Build from the REPO ROOT:
#   docker build -f apps/worker/Dockerfile -t orreris-worker .
# Runs TypeScript via tsx (its real `start`); no compile step. Needs Chromium's system libraries for
# the headless render, plus the Prisma client (it reads the same DB the API writes).
FROM node:24-bookworm-slim AS runtime

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate

# System libraries Remotion's Chrome Headless Shell needs on Debian bookworm (per Remotion's Docker
# guide — bookworm uses libasound2, NOT the Ubuntu 24.04 libasound2t64). Versions are intentionally
# NOT pinned: Debian removes old package versions, which would break future rebuilds if pinned. Noto
# fonts give emoji + CJK coverage so captions/overlays render correctly headless; ca-certificates so
# HTTPS fetches (presigned R2 GETs) validate.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates openssl \
      libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 \
      libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 \
      libpango-1.0-0 libcairo2 libcups2 \
      fonts-noto-color-emoji fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# tsx is a devDependency but REQUIRED at runtime → no --prod prune.
RUN pnpm install --frozen-lockfile

# Prisma client for the worker (it shares the generated client in the workspace node_modules).
RUN pnpm --filter @orreris/api prisma:generate

# Pre-download Chrome Headless Shell at BUILD time so the first render doesn't pay the download and a
# render never needs network to fetch the browser. Uses the SAME ensureBrowser() primitive the worker
# calls at runtime (remotion-renderer.ts), run inside apps/worker so @remotion/renderer resolves — the
# `remotion` CLI bin is not linked in this pnpm workspace, so the CLI form would fail. The Playwright
# export-worker-scene CLI is NOT the queue path, so its browsers are deliberately not installed here.
RUN cd apps/worker && node --input-type=module -e "import { ensureBrowser } from '@remotion/renderer'; await ensureBrowser();"

# Worker daemon. Set WORKER_QUEUE=bullmq + REDIS_URL to consume the queue (must match the API);
# otherwise it falls back to polling Postgres. Needs the same DATABASE_URL + STORAGE_DRIVER/R2_* as
# the API so it can read source media and persist the finished mp4.
CMD ["pnpm", "--filter", "@orreris/worker", "start"]
