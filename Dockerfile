FROM node:22-slim AS builder

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml tsconfig.json ./

RUN pnpm install --frozen-lockfile

COPY src/ ./src/

RUN pnpm build

FROM node:22-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y chromium

COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/

CMD ["node", "dist/index.js"]