# Karvi — zero-dependency Node.js task engine
# Multi-purpose: works with fly deploy, docker build, Railway
FROM node:22-alpine

# Data directory — mount a volume here for persistence
# Must run as root before switching to non-root user
RUN mkdir -p /data/briefs /data/vaults && chown -R node:node /data

# Non-root user for security (node user exists in node:alpine)
USER node

WORKDIR /app

# Copy application code (no build step needed — zero dependencies)
COPY --chown=node:node package.json ./
COPY --chown=node:node server/ ./server/
COPY --chown=node:node index.html ./
COPY --chown=node:node brief-panel/ ./brief-panel/
COPY --chown=node:node deploy/ ./deploy/

VOLUME /data

# Default environment
ENV PORT=3461
ENV DATA_DIR=/data
ENV NODE_ENV=production

EXPOSE 3461

# Health check using Node.js (no curl in alpine)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http=require('http');const r=http.get('http://localhost:3461/health',s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(4000,()=>{r.destroy();process.exit(1)})"

CMD ["node", "server/server.js"]
