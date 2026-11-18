FROM node:26-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY contract ./contract
USER node
EXPOSE 8080
CMD ["node", "src/main.ts", "--config", "/config/config.yml"]
