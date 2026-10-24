# visend-server
# visend is a fast cross-platform tool way to send anything to telegram.
# Author: vishota - https://github.com/vishota/visend
#
# Multi-stage build: compile TS, ship a minimal runtime image.
FROM node:24-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine3.24
LABEL org.opencontainers.image.title="visend-server" \
      org.opencontainers.image.description="visend is a fast cross-platform tool way to send anything to telegram - shared server component" \
      org.opencontainers.image.authors="vishota" \
      org.opencontainers.image.url="https://github.com/vishota/visend#readme" \
      org.opencontainers.image.source="https://github.com/vishota/visend" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist

# Run as the unprivileged node user.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/status >/dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]
