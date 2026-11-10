FROM node:22.22.0-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --chown=node:node runtime/package.json ./
COPY --chown=node:node runtime/node_modules ./node_modules
COPY --chown=node:node runtime/dist ./dist
COPY --chown=node:node runtime/recipes ./recipes
COPY --chown=node:node supervisor.mjs ./
RUN ./node_modules/.bin/playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*
USER node
ENTRYPOINT ["node", "/app/supervisor.mjs"]
