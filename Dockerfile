FROM node:22-slim AS builder

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml tsconfig.json ./

RUN pnpm install --frozen-lockfile

COPY src/ ./src/

RUN pnpm build

FROM node:22-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y chromium time

COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/

# Uncomment this to measure time taken & mem peak to run the application
# CMD ["/usr/bin/time", "-v", "node", "dist/index.js"]
CMD ["node", "dist/index.js"]