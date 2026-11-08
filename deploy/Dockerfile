# MOTERVA API — release image (issue #19).
#
# Build from the REPOSITORY ROOT (the whole monorepo is the context):
#   docker build -f deploy/Dockerfile -t moterva-api:<release-sha> .
#
# Single build stage, then `npm prune --omit=dev` so the runtime layer keeps
# only production dependencies. Runs as the non-root `node` user. The ledger
# lives on a mounted volume (MOTERVA_LEDGER_PATH=/var/lib/moterva/ledger.sqlite);
# nothing here may ever enable MOTERVA_DEV_AUTH (the app refuses it in
# production by design — see apps/api/src/config.ts).

FROM node:24-slim AS build
WORKDIR /repo
COPY . .
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /repo
COPY --from=build /repo .
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    MOTERVA_LEDGER_PATH=/var/lib/moterva/ledger.sqlite
# Container-private bind only; never published directly by docker-compose
# (the Caddy edge is the single exposed service). HEALTHCHECK uses node
# itself — the slim image ships no curl/wget.
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/api/dist/index.js"]
