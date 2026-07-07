FROM node:22-slim AS builder

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml tsconfig.json tsconfig.build.json ./

RUN pnpm install --frozen-lockfile

COPY src/ ./src/

RUN pnpm build

FROM node:22-slim AS runner

# Chrome for Testing build matched to puppeteer-core (see pptr.dev/supported-browsers).
# Bump this together with the puppeteer-core version in package.json.
ARG CHROME_VERSION=150.0.7871.24

WORKDIR /app

RUN apt-get update && apt-get install -y ca-certificates \
  fonts-liberation \
  libasound2 \
	libatk-bridge2.0-0 \
	libatk1.0-0 \
	libc6 \
	libcairo2 \
	libcups2 \
	libdbus-1-3 \
	libexpat1 \
	libfontconfig1 \
	libgbm1 \
	libgcc1 \
	libglib2.0-0 \
	libgtk-3-0 \
	libnspr4 \
	libnss3 \
	libpango-1.0-0 \
	libpangocairo-1.0-0 \
	libstdc++6 \
	libx11-6 \
	libx11-xcb1 \
	libxcb1 \
	libxcomposite1 \
	libxcursor1 \
	libxdamage1 \
	libxext6 \
	libxfixes3 \
	libxi6 \
	libxrandr2 \
	libxrender1 \
	libxss1 \
	libxtst6 \
	lsb-release \
	unzip \
	wget \
	xdg-utils

RUN npx -y @puppeteer/browsers install chrome@${CHROME_VERSION} --path /opt/chrome \
  && ln -s /opt/chrome/chrome/linux-${CHROME_VERSION}/chrome-linux64/chrome /usr/bin/chrome \
  && /usr/bin/chrome --version

COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/

CMD ["node", "dist/index.js"]