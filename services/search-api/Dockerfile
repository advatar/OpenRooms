# syntax=docker/dockerfile:1

# --- Build stage ---
FROM node:20-alpine AS builder
WORKDIR /app

# Copy root workspace files and the services directory (for workspace-aware install)
COPY package.json package-lock.json ./
COPY services ./services

# Install only the workspace dependencies for search-api
RUN npm ci --workspace services/search-api

# Build the TypeScript project
RUN npm run -w services/search-api build

# Prune dev dependencies for runtime to reduce image size
RUN npm prune --omit=dev --workspace services/search-api

# --- Runtime stage ---
FROM node:20-alpine AS runner
ENV NODE_ENV=production
WORKDIR /app

# Copy built workspace app (includes dist, package.json, node_modules, etc.)
COPY --from=builder /app/services/search-api /app

# Ensure an app-writable uploads directory (default can be overridden by env)
ENV UPLOAD_DIR=/app/uploads
RUN mkdir -p /app/uploads \
  && chown -R node:node /app

USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
