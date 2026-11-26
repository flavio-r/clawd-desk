# ClawdDesk em modo servidor (online, com login). Use junto com o docker-compose.yml, que põe o
# Caddy na frente para o HTTPS. Os dados (usuários, PCs ligados, logins) ficam no volume /data.
FROM node:22-alpine

ENV NODE_ENV=production \
    CLAWDDESK_MODE=server \
    CLAWDDESK_DATA_DIR=/data \
    CLAWDDESK_PORT=3456 \
    CLAWDDESK_HOST=0.0.0.0

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME /data
EXPOSE 3456
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3456/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
