FROM --platform=$BUILDPLATFORM node:22.22.0-alpine AS build

RUN corepack enable && corepack prepare pnpm@11.8.0 --activate
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --frozen-lockfile

COPY apps/server apps/server
COPY apps/web apps/web
COPY packages/contracts packages/contracts
COPY packages/domain packages/domain
COPY recipes recipes
COPY catalog catalog
RUN pnpm --filter @poe-worksmith/domain build \
  && pnpm --filter @poe-worksmith/contracts build \
  && pnpm --filter @poe-worksmith/server build \
  && pnpm --filter @poe-worksmith/web build \
  && node apps/server/dist/recipes/validateCatalog.js recipes \
  && pnpm --filter @poe-worksmith/server deploy --prod --legacy /opt/server
RUN cd /opt/server \
  && node -e "await Promise.all([import('./dist/api.js'), import('@poe-worksmith/contracts'), import('@poe-worksmith/domain')])"

FROM nginxinc/nginx-unprivileged:1.29-alpine AS web

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html

FROM node:22.22.0-bookworm-slim AS server

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY --from=build --chown=node:node /opt/server ./
RUN PLAYWRIGHT_BROWSERS_PATH=/ms-playwright ./node_modules/.bin/playwright install --with-deps chromium

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
    POE_REQUEST_TIMEOUT_MS=15000 \
    POE_USER_AGENT="OAuth poe-worksmith/0.0.0 (contact: local-development)" \
    REFRESH_CRON="0 * * * *" \
    RETENTION_BATCH_SIZE=500 \
    SHUTDOWN_TIMEOUT_MS=30000 \
    SNAPSHOT_TTL_MS=1800000

COPY --from=build --chown=node:node /workspace/apps/server/drizzle ./drizzle
COPY --from=build --chown=node:node /workspace/apps/server/mappings ./mappings
COPY --from=build --chown=node:node /workspace/apps/server/presentation ./presentation
COPY --from=build --chown=node:node /workspace/recipes ./recipes
COPY --from=build --chown=node:node /workspace/catalog ./catalog
RUN install -d -o node -g node -m 0700 /home/node/worksmith-trade

USER node
EXPOSE 3000
CMD ["node", "dist/entrypoints/all.js"]

FROM server AS app

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx-light \
  && rm -rf /var/lib/apt/lists/* \
  && chown -R node:node /var/lib/nginx
COPY --from=web /usr/share/nginx/html /srv/worksmith-web
COPY deploy/nginx-server.conf /etc/nginx/worksmith.conf
COPY deploy/start-server-app.sh /app/start-server-app.sh

USER node
EXPOSE 8080
CMD ["bash", "/app/start-server-app.sh"]
