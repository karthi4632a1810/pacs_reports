FROM node:20-alpine

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy application source
COPY server.js db.js minioClient.js ./
COPY scripts ./scripts
COPY public ./public

# Environment variables
ENV NODE_ENV=production
ENV PORT=2009
ENV PACS_HOST=http://192.168.101.224

EXPOSE 2009

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:2009/health || exit 1

CMD ["node", "server.js"]
