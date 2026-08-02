ARG NODE_IMAGE=node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f
ARG NPM_VERSION=11.13.0

FROM ${NODE_IMAGE} AS dependencies

ARG NPM_VERSION

WORKDIR /app

RUN apt-get update \
  && apt-get install --yes --no-install-recommends g++ make python3 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "npm@${NPM_VERSION}" --no-audit --no-fund

COPY package.json package-lock.json ./
COPY apps/controller/package.json apps/controller/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/esp-protocol/package.json packages/esp-protocol/package.json
COPY packages/fake-esp/package.json packages/fake-esp/package.json

RUN npm ci --no-audit --no-fund

FROM dependencies AS build

COPY . .

RUN npm run build \
  && npm prune --omit=dev --no-audit --no-fund

FROM dependencies AS verification

COPY . .

RUN npm run verify

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
  AQUARIUM_HOST=0.0.0.0 \
  AQUARIUM_PORT=3001 \
  AQUARIUM_WEB_ROOT=/app/apps/web/dist

WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/controller/package.json ./apps/controller/package.json
COPY --from=build --chown=node:node /app/apps/controller/dist ./apps/controller/dist
COPY --from=build --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=build --chown=node:node /app/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=node:node /app/packages/esp-protocol/package.json ./packages/esp-protocol/package.json
COPY --from=build --chown=node:node /app/packages/esp-protocol/dist ./packages/esp-protocol/dist
COPY --from=build --chown=node:node /app/packages/fake-esp/package.json ./packages/fake-esp/package.json
COPY --from=build --chown=node:node /app/packages/fake-esp/dist ./packages/fake-esp/dist
COPY --from=build --chown=node:node /app/firmware/esp32/artifacts ./firmware/esp32/artifacts

RUN mkdir -p \
      /var/lib/aquarium/state \
      /var/lib/aquarium/events \
      /var/lib/aquarium/archives \
      /var/lib/aquarium/backups \
      /var/lib/fake-esp \
  && chown -R node:node /var/lib/aquarium /var/lib/fake-esp

USER node

EXPOSE 3001 3002
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/health/ready').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "apps/controller/dist/server.js"]
