# prerender-jobs

Prerender engine that fetches pages via headless Chromium, captures full HTML snapshots, and syncs them to Cloudflare R2 at deterministic per-page keys.

## How it works

The job runs in four top-level steps:

1. **Prepare URLs** — merges `PATHS_LIST` (resolved against `BASE_URL`) with all URLs discovered from the sitemap, deduplicates, normalises them, and strips tracking params (`utm_*`, click IDs) so URL variants share one render and one cache entry. If `SKIP_SITEMAP_PARSING=true`, sitemap discovery is skipped and only the paths in `PATHS_LIST` are used. Each path entry can specify its own `ttl` (cache TTL in seconds).
2. **Launch browsers** — one headless Chromium instance (puppeteer-core) per stream, `CONCURRENCY` streams total (capped at the URL count). Each stream's browser is recycled every 20 renders to avoid Chromium memory bloat and relaunched on demand if it dies. Stream start-up is staggered by 2 s so concurrent boot phases don't hit the container at once.
3. **Run pipeline streams** — each stream pulls the next URL as soon as it finishes its current one (no batch barrier, so one slow render never idles the other streams). All streams share a job-wide in-memory asset cache: each unique script/stylesheet/font/image is fetched from the customer's origin once and served from memory on later renders (disable with `DISABLE_ASSET_CACHE=true`). Every URL flows through a per-URL pipeline:
   1. **Render** — navigates the URL in a new tab and waits for the page to be ready (see [Readiness detection](#readiness-detection) below). A near-empty snapshot (loading shell) is retried once with 4× stability windows; if rendering fails the URL is skipped.
   2. **Analyse SEO** — parses the rendered HTML to extract SEO signals (title, meta description, canonical, robots directives, soft-404 verdict, etc.). If analysis fails the URL is skipped.
   3. **Sync cache** — uploads the sanitized HTML snapshot (with SEO + render-diagnostics metadata) to Cloudflare R2 at its deterministic per-page key (skipped when `SKIP_CACHE_SYNC=true`).
4. **Report result** — POSTs a JSON summary to `WEBHOOK_URL` (if configured); a Telegram alert is additionally sent for the final retry run or a manual run that finished with failures. Both paths are fire-and-log; errors do not abort the job. Fatal errors that crash the job also trigger a Telegram message with the `CLOUD_RUN_EXECUTION` ID and failure reason.

### Readiness detection

After the initial page load, the engine polls until one of the following conditions is met (in priority order):

| Signal                    | Trigger                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| App signal                | `window.prerenderReady === true` or `window.htmlSnapshot === true`, once first-party requests are quiet |
| Network + DOM stable      | No pending first-party requests for 500 ms **and** no DOM mutations for 500 ms                      |
| Network stable (extended) | Network idle for 500 ms, DOM still mutating — snapshot taken after an additional 3 s                |
| Hard timeout              | 30 s elapsed since navigation                                                                       |

Additional gates on top of the table:

- **Head metadata** — except on hard timeout, the snapshot also waits until `<head>` carries a non-empty `<title>` (or a react-helmet meta), followed by a final 300 ms DOM settle for late meta injections.
- **Main-thread heartbeat** — an injected 100 ms counter must advance ≥ 3 ticks after network idle; a CPU-starved renderer (quiet network, frozen main thread) is not mistaken for a stable page.
- **Retry widening** — when a render is retried after a thin (loading-shell) snapshot, all quiet/stable/settle windows above are widened 4×.
- **Attempt caps** — each render attempt is capped at 65 s overall (navigation itself at 30 s); a frame-detach error triggers one retry with a fresh page. Navigation loops abort after 10 top-level navigations.

Third-party domains (analytics, fonts, ad networks) are excluded from network idle tracking.

---

## Local testing

### 1. Set up environment variables

Copy the sample file and fill in your values:

```bash
cp .env.sample .env.local
```

| Variable                 | Required | Default                  | Description                                                                                                                     |
| ------------------------ | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `BATCH_ID`               | yes      | —                        | Unique identifier for this batch, passed through to the webhook payload as `batch_id`                                           |
| `USER_ID`                | yes      | —                        | User identifier for this batch, passed through to the webhook payload as `user_id`                                              |
| `REQUEST_SOURCE`         | yes      | —                        | Job trigger identifier (e.g. `scheduler`, `manual`); sent as `source` in the webhook                                            |
| `DOMAIN`                 | yes      | —                        | The domain being prerendered (e.g. `example.com`); sent as `domain` in the webhook                                              |
| `ORIGIN_HOST`            | yes      | —                        | The origin host to fetch pages from (e.g. `origin.example.com`); sent as `origin_host` in the webhook                           |
| `BASE_URL`               | yes      | —                        | Base URL for prerendering, e.g. `https://example.com` (must start with `https://`)                                              |
| `PATHS_LIST`             | yes      | —                        | JSON array of path entries, e.g. `[{"path":"/","ttl":604800},{"path":"/about","ttl":86400}]`. Each `path` must start with `/`. `ttl` (seconds) defaults to 604800 (7 days) if omitted |
| `CF_ACCOUNT_ID`          | yes      | —                        | Cloudflare account ID                                                                                                           |
| `R2_ACCESS_KEY_ID`       | yes      | —                        | R2 S3-compatible access key                                                                                                     |
| `R2_SECRET_ACCESS_KEY`   | yes      | —                        | R2 S3-compatible secret key                                                                                                     |
| `R2_BUCKET_NAME`         | yes      | —                        | Target R2 bucket name                                                                                                           |
| `RETRY_OPTIONS`          | no       | —                        | JSON string forwarded as `retry_options` in the webhook for downstream retry handling                                           |
| `SITEMAP_URL`            | no       | `<hostname>/sitemap.xml` | Explicit sitemap URL                                                                                                            |
| `SITEMAP_UPDATED_WITHIN` | no       | `all`                    | Filter sitemap URLs by lastmod: `1d`, `3d`, `7d`, `30d`, `all`                                                                  |
| `USER_AGENT`             | no       | Chrome 124 UA string     | Custom user agent string                                                                                                        |
| `CONCURRENCY`            | no       | `1`                      | Number of pages to render in parallel                                                                                           |
| `SKIP_CACHE_SYNC`        | no       | `true`                   | Set to `false` to upload results to R2                                                                                   |
| `SKIP_SITEMAP_PARSING`   | no       | `false`                  | Set to `true` to skip sitemap discovery and only render URLs in `PATHS_LIST`                                                    |
| `CANONICAL_DOMAIN`       | no       | value of `DOMAIN`        | Preferred hostname rewritten into canonical/og:url/base tags                                                                    |
| `ENCITED_INTERNAL_KEY`   | no       | —                        | Sent as `X-Encited-Internal-Key` on first-party requests so the Fly proxy exempts them from per-IP rate limiting                |
| `WEBHOOK_URL`            | no       | —                        | Callback URL called on completion                                                                                               |
| `WEBHOOK_SIGNATURE`      | no       | —                        | Secret sent as `x-webhook-signature` header with every webhook request                                                          |
| `TELEGRAM_BOT_TOKEN`     | no       | —                        | Telegram bot token for result/failure notifications; Telegram is skipped if unset                                               |
| `TELEGRAM_CHAT_ID`       | no       | —                        | Telegram chat ID to send notifications to; Telegram is skipped if unset                                                         |
| `OUTPUT_DIR`             | no       | —                        | When set, each run writes its HTML snapshots and a `summary.json` into a timestamped subdirectory (local testing aid)           |
| `DISABLE_ASSET_CACHE`    | no       | `false`                  | Set to `true` to disable the job-wide asset cache (every render fetches all assets from origin; for A/B measurement)            |

### 2. Run via Docker

Docker handles Chromium installation automatically.

```bash
pnpm exec:local
# or: bash execute-on-local.sh
```

This builds the image and runs it with `.env.local` injected as environment variables.

---

## Deployment (Google Cloud Run Job)

The job runs on Google Cloud Run. The Cloud Run Job is defined in `cloudrun-job.yaml` (2 vCPU, 2 GiB memory, 20-minute timeout, project `seotools01`).

All deploy scripts default to job name `prerender-jobs` in region `us-east1`. Override either with the `JOB_NAME` and `REGION` env vars. Both jobs share the same `gcr.io` image (it's global), so you can run several independently-named jobs across regions at once. To stand up a **new** job for the first time, run the steps in this order — the job must exist before `deploy.sh`'s image update can target it:

```bash
# Default job, unchanged:
pnpm update-job && pnpm deploy:job && pnpm exec:cloud   # prerender-jobs / us-east1

# Enterprise job (prerender-jobs-enterprise / us-central1), via dedicated scripts:
pnpm update-job:enterprise   # creates the job
pnpm deploy:job:enterprise   # builds + points image at it
pnpm exec:cloud:enterprise   # runs it
```

The `:enterprise` scripts just set `JOB_NAME` / `REGION` for you; you can still target any job/region ad hoc by setting those env vars on the base scripts.

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

## Result reporting

On completion the job POSTs a JSON summary to `WEBHOOK_URL` (if configured). A Telegram summary is additionally sent when the run is the final retry (`retry_count` of 2) or a manual run that finished with failures.

```jsonc
{
  "batch_id": "BATCH_ID", // value of the BATCH_ID env var
  "user_id": "USER_ID", // value of the USER_ID env var
  "source": "scheduler", // value of the REQUEST_SOURCE env var
  "google_cloud_execution_id": "abc123", // Cloud Run execution ID, or "local"
  "domain": "example.com",
  "canonical_domain": "example.com",
  "origin_host": "origin.example.com",
  "urls_rendered": 42,
  "urls_synced_r2": 42,
  "urls_synced_kv": 0, // always 0 — KV sync was removed; field kept for contract compatibility
  "sitemap_url": "https://example.com/sitemap.xml", // "skipped" when SKIP_SITEMAP_PARSING=true
  "sitemap_filter": "all",
  "started_at": "2026-07-23T00:00:00.000Z", // ISO 8601 UTC
  "finished_at": "2026-07-23T00:05:00.000Z",
  "failed": {
    // entries are { "path": "/x", "error": { "reason": "...", "status": 404 } }
    // reasons: fetch_error (with HTTP status), too_many_redirects,
    // navigation_loop, sync_failed, unknown
    "failed_to_render": { "paths": [], "count": 0 }, // URL paths (not full URLs)
    "failed_to_sync": { "paths": [], "count": 0 }, // URL paths (not full URLs)
  },
  "success_paths": ["/", "/about", "/blog/post-1"], // paths fully rendered and synced to R2
  // present only when RETRY_OPTIONS is set:
  "retry_options": {
    /* parsed from RETRY_OPTIONS env var */
  },
}
```

The webhook request includes an `x-webhook-signature` header (empty string if `WEBHOOK_SIGNATURE` is not set).

If the job exits with a fatal error before reaching the report step, a separate Telegram message is sent containing the `google_cloud_execution_id` and the error reason.
