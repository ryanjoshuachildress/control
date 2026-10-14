# Multi-stage build. The runtime image runs pure JavaScript only —
# better-sqlite3 (and its compiler toolchain) lives solely in the migrator
# stage used for the one-shot SQLite → PostgreSQL import.

# 1) Build the React frontend
FROM node:22-alpine AS web
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# 2) Runtime dependencies (no native modules — better-sqlite3 is a devDep)
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# 3) One-shot migrator: needs better-sqlite3 (to read the legacy database)
FROM node:20-slim AS migrator
ENV NODE_ENV=production
ENV DATA_DIR=/data
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

# 4) Runtime
FROM node:20-slim
ENV NODE_ENV=production
ENV DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY migrations ./migrations
COPY --from=web /build/dist ./web/dist
RUN mkdir -p /data && chmod 777 /data
EXPOSE 3000
CMD ["node", "src/server.js"]