# syntax=docker/dockerfile:1
# Orreris web (Vite SPA). Build from the REPO ROOT: docker build -f apps/web/Dockerfile -t orreris-web .
# Vite INLINES VITE_* at build time, so the API base + Google client id are build args, not runtime env.
FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

# Baked into the bundle. Default = same-origin "/api" (served by the nginx proxy below), so a
# single-host compose deploy works with no extra config. For a SPLIT deploy (web and api on different
# hosts), pass --build-arg VITE_API_URL=https://api.example.com/api instead.
ARG VITE_API_URL=/api
ARG VITE_GOOGLE_CLIENT_ID=
ENV VITE_API_URL=$VITE_API_URL \
    VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
RUN pnpm --filter @orreris/web build

# ---- Serve the static build with nginx ----
FROM nginx:1.27-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
