FROM node:20-alpine

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install production dependencies
RUN apk add --no-cache poppler-utils chromium font-noto font-noto-cjk nss freetype harfbuzz ttf-freefont \
 && npm install --omit=dev

# Copy application source
COPY server.js db.js minioClient.js auth.js reportGenerator.js reportsApi.js settingsManager.js ./
COPY scripts ./scripts
COPY public ./public

# Environment variables
ENV NODE_ENV=production
ENV PORT=2020
ENV PACS_HOST=http://103.102.85.3

EXPOSE 2020

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:2020/health || exit 1

CMD ["node", "server.js"]
