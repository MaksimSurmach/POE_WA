FROM node:22.22.0-alpine
WORKDIR /app
COPY --chown=node:node runtime/package.json ./
COPY --chown=node:node runtime/node_modules ./node_modules
COPY --chown=node:node runtime/dist ./dist
COPY --chown=node:node supervisor.mjs ./
USER node
ENTRYPOINT ["node", "/app/supervisor.mjs"]
