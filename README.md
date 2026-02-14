# prerender-jobs

Prerender engine that fetches pages via headless Chromium, captures full HTML snapshots, and syncs them to Cloudflare R2 + KV.

## How it works

The pipeline runs in five steps:

1. **Prepare URLs** — merges `URL_LIST` with all URLs discovered from the sitemap, deduplicates, and normalises them.
2. **Render pages** — opens each URL in a headless Chromium tab (puppeteer-core) and waits for the page to be ready (see [Readiness detection](#readiness-detection) below).
3. **Analyse SEO** — parses the rendered HTML to extract SEO signals (title, meta description, canonical, robots directives, etc.).
4. **Sync cache** — uploads the HTML snapshot to Cloudflare R2 and writes the metadata index to Cloudflare KV (skipped when `SKIP_CACHE_SYNC=true`).
5. **Webhook** — POSTs a JSON summary to `WEBHOOK_URL` (skipped when not configured).

### Readiness detection

After the initial page load, the engine polls until one of the following conditions is met (in priority order):

| Signal                    | Trigger                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------ |
| App signal                | `window.prerenderReady === true` or `window.htmlSnapshot === true`                   |
| Network + DOM stable      | No pending first-party requests for 500 ms **and** no DOM mutations for 300 ms       |
| Network stable (extended) | Network idle for 500 ms, DOM still mutating — snapshot taken after an additional 3 s |
| Hard timeout              | 15 s elapsed since navigation                                                        |

Third-party domains (analytics, fonts, ad networks) are excluded from network idle tracking.

---

## Local testing

### 1. Set up environment variables

Copy the sample file and fill in your values:

```bash
cp .env.sample .env.local
```

| Variable                 | Required | Default                  | Description                                                                  |
| ------------------------ | -------- | ------------------------ | ---------------------------------------------------------------------------- |
| `URL_LIST`               | yes      | —                        | Comma-separated list of URLs to prerender (all must share the same hostname) |
| `CF_ACCOUNT_ID`          | yes      | —                        | Cloudflare account ID                                                        |
| `CF_API_TOKEN`           | yes      | —                        | Cloudflare API token (KV write access)                                       |
| `R2_ACCESS_KEY_ID`       | yes      | —                        | R2 S3-compatible access key                                                  |
| `R2_SECRET_ACCESS_KEY`   | yes      | —                        | R2 S3-compatible secret key                                                  |
| `R2_BUCKET_NAME`         | yes      | —                        | Target R2 bucket name                                                        |
| `KV_NAMESPACE_ID`        | yes      | —                        | KV namespace ID for the cache index                                          |
| `SITEMAP_URL`            | no       | `<hostname>/sitemap.xml` | Explicit sitemap URL                                                         |
| `SITEMAP_UPDATED_WITHIN` | no       | `all`                    | Filter sitemap URLs by lastmod: `1d`, `3d`, `7d`, `30d`, `all`               |
| `CACHE_TTL`              | no       | `604800` (7 days)        | Cache TTL in seconds                                                         |
| `USER_AGENT`             | no       | Chrome 124 UA string     | Custom user agent string                                                     |
| `CONCURRENCY`            | no       | `1`                      | Number of pages to render in parallel                                        |
| `SKIP_CACHE_SYNC`        | no       | `true`                   | Set to `false` to upload results to R2 and KV                                |
| `WEBHOOK_URL`            | no       | —                        | Callback URL called on completion                                            |

### 2. Run via Docker

Docker handles Chromium installation automatically.

```bash
pnpm exec:local
# or: bash execute-on-local.sh
```

This builds the image and runs it with `.env.local` injected as environment variables.

---

## Deployment (Google Cloud Run Job)

The job runs on Google Cloud Run. The Cloud Run Job is defined in `cloudrun-job.yaml` (2 vCPU, 2 GiB memory, `us-east1`, project `seotools01`).

### 1. Set up production environment variables

Create `.env.production` with the same variables as `.env.local`. A trailing newline is required for correct parsing:

```bash
cp .env.sample .env.production
# fill in production values — ensure the file ends with a newline
```

### 2. Build and deploy the image

Uses Google Cloud Build (`cloudbuild.yaml`) to build the Docker image, push it to Container Registry, and update the Cloud Run Job to use the new image:

```bash
pnpm deploy:job
# or: bash deploy.sh
```

### 3. Update the Cloud Run Job spec

Apply changes to the job configuration (resources, timeouts, etc.) from `cloudrun-job.yaml`:

```bash
pnpm update-job
# or: bash update-cloudrun-job.sh
```

### 4. Execute the job on Cloud Run

Runs the Cloud Run Job with environment variables loaded from `.env.production`:

```bash
pnpm exec:cloud
# or: bash execute-on-cloud.sh
```

---

## Webhook payload

When `WEBHOOK_URL` is set, a `POST` request is sent on completion with the following JSON body:

```jsonc
{
  "run_id": 1234567890, // epoch ms when the job started
  "domain": "example.com",
  "urls_rendered": 42,
  "urls_synced_r2": 42,
  "urls_synced_kv": 42,
  "sitemap_url": "https://example.com/sitemap.xml",
  "sitemap_filter": "all",
  "started_at": 1234567890,
  "finished_at": 1234567899,
  "failed": {
    "failed_to_render": { "urls": [], "count": 0 },
    "failed_to_sync": { "urls": [], "count": 0 },
  },
}
```
