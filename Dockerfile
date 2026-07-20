FROM node:22.22.0-alpine AS build

RUN corepack enable && corepack prepare pnpm@11.8.0 --activate
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --frozen-lockfile

COPY apps/server apps/server
COPY packages/domain packages/domain
COPY recipes recipes
RUN pnpm --filter @poe-worksmith/domain build \
  && pnpm --filter @poe-worksmith/server build \
  && node apps/server/dist/recipes/validateCatalog.js recipes \
  && pnpm --filter @poe-worksmith/server deploy --prod --legacy /opt/server

FROM node:22.22.0-alpine AS runtime

ENV APP_ENV=development \
    APP_HOST=0.0.0.0 \
    APP_MODE=all \
    APP_PORT=3000 \
    CLEANUP_CRON="15 2 * * *" \
    JOB_LEASE_TIMEOUT_MS=300000 \
    LOG_LEVEL=info \
    MARKET_CONCURRENCY=4 \
    MARKET_RETRY_DELAY_MS=60000 \
    NODE_ENV=production \
    PG_BOSS_SCHEMA=pgboss \
    POE_LEAGUE=Mercenaries \
    POE_USER_AGENT="POE-Worksmith/0.0.0 (contact: local-development)" \
    REFRESH_CRON="0 */4 * * *" \
    RETENTION_BATCH_SIZE=500 \
    SHUTDOWN_TIMEOUT_MS=30000 \
    SNAPSHOT_TTL_MS=1800000

WORKDIR /app
COPY --from=build --chown=node:node /opt/server ./
COPY --from=build --chown=node:node /workspace/recipes ./recipes

USER node
EXPOSE 3000
CMD ["node", "dist/entrypoints/all.js"]
