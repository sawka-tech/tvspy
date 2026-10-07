# syntax=docker/dockerfile:1

# Build: compile the backend and the frontend.
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY shared/package.json shared/
COPY tvspy-backend/package.json tvspy-backend/
COPY tvspy-frontend/package.json tvspy-frontend/
RUN npm ci --no-audit --no-fund
COPY shared shared
COPY tvspy-backend tvspy-backend
COPY tvspy-frontend tvspy-frontend
RUN npm run build --workspace tvspy-backend && npm run build --workspace tvspy-frontend

# Runtime dependencies only (better-sqlite3 ships prebuilt binaries; no compiler needed).
FROM node:24-bookworm-slim AS prod-deps
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY tvspy-backend/package.json tvspy-backend/
COPY tvspy-frontend/package.json tvspy-frontend/
RUN npm ci --omit=dev --workspace tvspy-backend --no-audit --no-fund \
 && rm -rf node_modules/@tvspy  # workspace links; nothing imports them at runtime

FROM node:24-bookworm-slim
ARG TVSPY_VERSION=4.0.0-dev
ARG TVSPY_COMMIT=
ENV NODE_ENV=production \
    PORT=80 \
    TZ=Europe/Warsaw \
    TVSPY_DATA_DIR=/app/backend/src/database/file \
    TVSPY_PUBLIC_DIR=/app/public \
    TVSPY_VERSION=${TVSPY_VERSION} \
    TVSPY_COMMIT=${TVSPY_COMMIT}
WORKDIR /app/backend
COPY --from=prod-deps /src/node_modules /app/node_modules
COPY --from=build /src/tvspy-backend/dist ./dist
COPY --from=build /src/tvspy-frontend/dist /app/public
COPY tvspy-backend/package.json ./package.json
# Runs as root like the previous image: existing appdata is root-owned and the app binds port 80.
RUN mkdir -p "$TVSPY_DATA_DIR"
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||80)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
