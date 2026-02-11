# seotools-ts

Prerender engine that fetches pages via headless Chromium, captures full HTML snapshots, and syncs them to Cloudflare R2 + KV.

## Local testing

### 1. Set up environment variables

Copy the sample file and fill in your values:

```bash
cp .env.sample .env.local
```

| Variable | Required | Description |
|---|---|---|
| `URL_LIST` | yes | Comma-separated list of URLs to prerender |
| `CF_ACCOUNT_ID` | yes | Cloudflare account ID |
| `CF_API_TOKEN` | yes | Cloudflare API token (KV write access) |
| `R2_ACCESS_KEY_ID` | yes | R2 S3-compatible access key |
| `R2_SECRET_ACCESS_KEY` | yes | R2 S3-compatible secret key |
| `R2_BUCKET_NAME` | yes | Target R2 bucket name |
| `KV_NAMESPACE_ID` | yes | KV namespace ID for the cache index |
| `SITEMAP_URL` | no | Explicit sitemap URL (defaults to `<first-url-hostname>/sitemap.xml`) |
| `SITEMAP_UPDATED_WITHIN` | no | Filter sitemap URLs by lastmod: `1d`, `3d`, `7d`, `30d`, `all` (default: `all`) |
| `CACHE_TTL` | no | Cache TTL in seconds (default: `604800` / 7 days) |
| `USER_AGENT` | no | Custom user agent string |
| `WEBHOOK_URL` | no | Callback URL called on completion |

### 2. Run via Docker (recommended)

Docker handles Chromium installation automatically.

```bash
bash run-local.sh
```

This builds the image and runs it with `.env.local` injected as environment variables.

### 3. Run directly with Node

Requires Chromium installed at `/usr/bin/chromium` on the host.

```bash
pnpm install
pnpm start:dev
```

`start:dev` sets `NODE_ENV=development`, which makes the app load `.env.local` via dotenv automatically.
