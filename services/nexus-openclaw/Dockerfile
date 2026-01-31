# ============================================================================
# OpenClaw Plugin - Multi-stage Docker Build
# ============================================================================
# UI Build Stage: Build Next.js static export
# Backend Build Stage: Compile TypeScript and install dependencies
# Production Stage: Minimal runtime with UI and backend
# Security: Non-root user, minimal attack surface, read-only where possible
# ============================================================================

# ============================================================================
# Stage 1: UI Builder - Build Next.js static export
# ============================================================================
FROM node:20-alpine AS ui-builder

WORKDIR /ui

# Install build dependencies
RUN apk add --no-cache git

# Copy package files first for better caching
COPY ui/package*.json ./

# Install dependencies
RUN npm ci

# Copy UI source code
COPY ui/ ./

# Set environment for build
ENV NODE_ENV=production
ENV SKIP_TYPE_CHECK=true
ENV SKIP_LINT=true
ENV NEXT_TELEMETRY_DISABLED=1

# Build Next.js static export (generates 'out' directory)
RUN npm run build

# ============================================================================
# Stage 2: Backend Builder - Compile TypeScript
# ============================================================================
FROM node:20-alpine AS backend-builder

# Build arguments for traceability
ARG NODE_VERSION=20
ARG BUILD_ID
ARG BUILD_TIMESTAMP
ARG GIT_COMMIT
ARG GIT_BRANCH
ARG VERSION

# Set working directory
WORKDIR /app

# Install build dependencies (required for native modules)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    && ln -sf python3 /usr/bin/python

# Copy package files first for better caching
COPY services/nexus-openclaw/package*.json ./

# Install ALL dependencies (including devDependencies for build)
RUN npm ci --include=dev

# Copy source code
COPY services/nexus-openclaw/src ./src
COPY services/nexus-openclaw/tsconfig.json ./
COPY services/nexus-openclaw/tsconfig.simple.json ./

# Build TypeScript to JavaScript
RUN npm run build

# Remove devDependencies, keep only production dependencies
RUN npm prune --production

# ============================================================================
# Stage 3: Production - Minimal runtime image
# ============================================================================
FROM node:20-alpine AS production

# Build arguments (re-declare for this stage)
ARG BUILD_ID
ARG BUILD_TIMESTAMP
ARG GIT_COMMIT
ARG GIT_BRANCH
ARG VERSION

# OCI Image Labels (standardized metadata)
LABEL org.opencontainers.image.title="OpenClaw Assistant" \
      org.opencontainers.image.description="Multi-channel AI assistant with 100+ skills, autonomous automation, and Nexus integration" \
      org.opencontainers.image.vendor="Adverant AI" \
      org.opencontainers.image.authors="Adverant AI <plugins@adverant.ai>" \
      org.opencontainers.image.url="https://adverant.ai/products/plugins/openclaw" \
      org.opencontainers.image.documentation="https://docs.adverant.ai/plugins/openclaw" \
      org.opencontainers.image.source="https://github.com/adverant/Adverant-Nexus-Plugin-OpenClaw" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.created="${BUILD_TIMESTAMP}" \
      com.adverant.build.id="${BUILD_ID}" \
      com.adverant.build.timestamp="${BUILD_TIMESTAMP}" \
      com.adverant.build.branch="${GIT_BRANCH}" \
      com.adverant.plugin.id="nexus-openclaw" \
      com.adverant.plugin.version="${VERSION}" \
      com.adverant.plugin.category="productivity" \
      com.adverant.plugin.execution-mode="hardened_docker"

# Install runtime dependencies only
RUN apk add --no-cache \
    dumb-init \
    curl \
    ca-certificates \
    tzdata \
    && rm -rf /var/cache/apk/*

# Create non-root user (uid 1001 as per security policy)
RUN addgroup -g 1001 -S openclaw && \
    adduser -u 1001 -S openclaw -G openclaw

# Set working directory
WORKDIR /app

# Copy built backend from builder stage
COPY --from=backend-builder --chown=openclaw:openclaw /app/dist ./dist
COPY --from=backend-builder --chown=openclaw:openclaw /app/node_modules ./node_modules
COPY --from=backend-builder --chown=openclaw:openclaw /app/package*.json ./

# Copy built UI static files from ui-builder stage
COPY --from=ui-builder --chown=openclaw:openclaw /ui/out ./ui/out

# Create directories for runtime data
RUN mkdir -p /tmp/openclaw /app/data /app/logs && \
    chown -R openclaw:openclaw /tmp/openclaw /app/data /app/logs

# Expose build metadata as environment variables
ENV NEXUS_BUILD_ID="${BUILD_ID}" \
    NEXUS_BUILD_TIMESTAMP="${BUILD_TIMESTAMP}" \
    NEXUS_GIT_COMMIT="${GIT_COMMIT}" \
    NEXUS_GIT_BRANCH="${GIT_BRANCH}" \
    NEXUS_VERSION="${VERSION}" \
    NODE_ENV=production \
    PORT=8080 \
    UI_BUILD_PATH=./ui/out

# Switch to non-root user
USER 1001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Expose application port
EXPOSE 8080

# Use dumb-init to handle signals properly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Start the application (full backend with WebSocket gateway)
CMD ["node", "dist/index.js"]

# ============================================================================
# Build Instructions (ALWAYS build on remote server):
# ============================================================================
# SSH into server (157.173.102.118):
#   ssh root@157.173.102.118
#
# Navigate to plugin directory:
#   cd /root/Adverant-Nexus-Plugin-OpenClaw
#
# Pull latest code:
#   git pull origin main
#
# Generate build metadata:
#   export SERVICE="nexus-openclaw"
#   export BUILD_ID="${SERVICE}-$(date +%Y%m%d)-$(openssl rand -hex 4)"
#   export BUILD_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
#   export GIT_COMMIT=$(git rev-parse --short HEAD)
#   export GIT_BRANCH=$(git branch --show-current)
#   export VERSION=$(grep '"version"' services/nexus-openclaw/package.json | head -1 | sed 's/.*: "\(.*\)".*/\1/')
#
# Build Docker image (includes UI build):
#   docker build \
#     --build-arg BUILD_ID="${BUILD_ID}" \
#     --build-arg BUILD_TIMESTAMP="${BUILD_TIMESTAMP}" \
#     --build-arg GIT_COMMIT="${GIT_COMMIT}" \
#     --build-arg GIT_BRANCH="${GIT_BRANCH}" \
#     --build-arg VERSION="${VERSION}" \
#     -t localhost:5000/nexus-openclaw:${BUILD_ID} \
#     -t localhost:5000/nexus-openclaw:latest \
#     -f services/nexus-openclaw/Dockerfile \
#     .
#
# Push to local registry:
#   docker push localhost:5000/nexus-openclaw:${BUILD_ID}
#   docker push localhost:5000/nexus-openclaw:latest
#
# Deploy to K3s:
#   k3s kubectl set image deployment/nexus-openclaw \
#     openclaw=localhost:5000/nexus-openclaw:${BUILD_ID} \
#     -n nexus
#
# Verify rollout:
#   k3s kubectl rollout status deployment/nexus-openclaw -n nexus
#
# Check build info:
#   k3s kubectl exec -n nexus deployment/nexus-openclaw -- env | grep NEXUS_
#   docker inspect localhost:5000/nexus-openclaw:latest | jq '.[0].Config.Labels'
#
# Verify UI is accessible:
#   curl https://api.adverant.ai/openclaw/ui
# ============================================================================
