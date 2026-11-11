# Imagen de la API (NestJS + Prisma). Se construye desde la RAÍZ del monorepo:
#   docker build -f apps/api/Dockerfile -t aguamata-api .
# La misma imagen sirve para la API, las migraciones (prisma migrate deploy) y el seed.

FROM node:22-bookworm-slim AS base
# OpenSSL: lo necesita el motor de Prisma.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm COREPACK_HOME=/corepack
RUN corepack enable
WORKDIR /app

FROM base AS build
# Primero solo los manifiestos: la instalación queda en caché mientras no cambien las dependencias.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@agua-mata/api..."
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @agua-mata/shared build \
 && pnpm --filter @agua-mata/api exec prisma generate \
 && pnpm --filter @agua-mata/api exec nest build

FROM base AS runtime
ENV NODE_ENV=production API_PORT=4000 STORAGE_DIR=/data/storage
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
