# ---- web (SPA served by the API service) ----
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./web/dist
COPY package.json ./
USER node
# Default command does scan + process. Override args with "scan" or "process" if needed.
# The web service runs the API instead: --command node --args dist/api/index.js
ENTRYPOINT ["node", "dist/index.js"]
CMD ["run"]
