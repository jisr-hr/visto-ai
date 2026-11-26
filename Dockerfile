FROM node:26-bookworm-slim AS ui
WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/ ./
COPY src/ui/api-types.ts /build/src/ui/api-types.ts
RUN npm run build

FROM node:26-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY contract ./contract
COPY --from=ui /build/ui/dist ./ui/dist
USER node
EXPOSE 8080
CMD ["node", "src/main.ts", "--config", "/config/config.yml"]
