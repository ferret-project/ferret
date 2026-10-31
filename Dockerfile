# ── Build ────────────────────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS build
WORKDIR /src
# Node 25+ no longer bundles Corepack; it still picks the pnpm in package.json's packageManager.
RUN npm install -g --no-audit --no-fund corepack && corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/docs/package.json apps/docs/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Install only what the bundled server keeps outside it: the native bits (libSQL, sharp, the canvas PDFs are drawn on)
# and pdf.js (its worker and fonts come from its own package).
FROM node:26-bookworm-slim AS runtime-deps
WORKDIR /deps
COPY --from=build /src/apps/server/package.json /tmp/server-package.json
RUN DEPS=$(node -p "const d=require('/tmp/server-package.json').dependencies; ['@libsql/client','sharp','pdfjs-dist','@napi-rs/canvas'].map(n => n+'@'+d[n]).join(' ')") \
 && npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund $DEPS

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:26-bookworm-slim
# Which Ferret this is (scripts/version.sh): CI passes it; Settings → Server shows it.
ARG FERRET_VERSION=dev
ENV FERRET_VERSION=$FERRET_VERSION \
    NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    WEB_DIST=/app/web \
    DOCS_DIST=/app/docs
WORKDIR /app
COPY --from=runtime-deps /deps/node_modules ./node_modules
COPY --from=build /src/apps/server/dist ./dist
COPY --from=build /src/apps/web/dist ./web
COPY --from=build /src/apps/docs/.vitepress/dist ./docs
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/server.js"]
