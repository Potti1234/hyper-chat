FROM node:24-alpine

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Dependencies first, for the layer cache. tsx runs the TypeScript sources
# and the scripts (demo:seed, user:create), so dev dependencies stay in.
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

EXPOSE 4300
CMD ["node", "--import", "tsx", "src/main.ts"]
