# Imagen de la web (Next.js en modo standalone). Se construye desde la RAÍZ del monorepo.
# Las tres variables quedan FIJAS en la compilación (por eso son argumentos de build):
#   docker build -f apps/web/Dockerfile \
#     --build-arg NEXT_PUBLIC_PLATFORM_ORIGIN=https://aguamata.co \
#     --build-arg API_INTERNAL_URL=http://api:4000 -t aguamata-web .

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm COREPACK_HOME=/corepack
RUN corepack enable
WORKDIR /app

FROM base AS build
ARG NEXT_PUBLIC_PLATFORM_ORIGIN
ARG API_INTERNAL_URL
ARG NEXT_PUBLIC_API_URL=/api/v1
ENV NEXT_PUBLIC_PLATFORM_ORIGIN=$NEXT_PUBLIC_PLATFORM_ORIGIN API_INTERNAL_URL=$API_INTERNAL_URL NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter "@agua-mata/web..."
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @agua-mata/shared build && pnpm --filter @agua-mata/web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# standalone trae solo lo necesario para correr; los archivos estáticos se copian aparte.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
