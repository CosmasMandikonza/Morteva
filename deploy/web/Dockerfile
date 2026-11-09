# MOTERVA web edge — Caddy serving the built static shell and reverse-proxying
# the API (issue #19). Build from the REPOSITORY ROOT:
#   docker build -f deploy/web/Dockerfile -t moterva-web:<release-sha> .
FROM node:24-slim AS webbuild
WORKDIR /repo
COPY . .
RUN npm ci && npm run build -w @moterva/web

FROM caddy:2.10-alpine
COPY deploy/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=webbuild /repo/apps/web/dist /srv/web
EXPOSE 80 443
