import {
  Browser,
  ConsoleMessage,
  HTTPRequest,
  HTTPResponse,
  Page,
} from "puppeteer-core";
import { getHostname } from "tldts";
import { AssetCache } from "./asset-cache";
import { RequestStats } from "./request-stats";
import { AppLogger } from "./logger";
import { RenderTracer } from "./render-tracer";
import { RenderFailureError } from "./prerender-failure";

const DEFAULT_RENDER_TIMEOUT = 65_000; // 65 seconds
const INTERNAL_PRERENDER_HEADER = "x-lovablehtml-internal";
// Shared secret the Fly proxy accepts to exempt first-party renders from
// per-IP rate limiting (lovablehtml/caddy-proxy/Caddyfile). Sent only to the
// render target and the customer's own hostnames, never to third parties.
const ENCITED_INTERNAL_KEY_HEADER = "x-encited-internal-key";
const MAX_NAVIGATIONS = 10;
const MAX_RENDER_ATTEMPTS = 2;
// Static asset types eligible for the job-wide AssetCache. Documents and
// xhr/fetch responses must never be cached — snapshots would capture stale
// data.
const CACHEABLE_ASSET_TYPES = new Set([
  "script",
  "stylesheet",
  "font",
  "image",
]);
// Cap diagnostics lists so a pathological page (e.g. an ad script erroring in a
// loop) can't grow them unbounded.
const DIAG_MAX_ENTRIES = 50;

export type RenderDiagnostics = {
  // What ended the readiness wait: app_signaled, network_and_dom_stable,
  // hard_timeout, etc. (see waitForPageReady).
  readyReason: string;
  // Wall-clock from render start to snapshot, in ms.
  durationMs: number;
  failedRequests: { url: string; error: string }[];
  // First-party requests still in flight when the snapshot was taken — useful
  // for diagnosing hard_timeout / dom_timeout snapshots (what was hanging).
  pendingRequests: string[];
  consoleErrors: string[];
  pageErrors: string[];
};

export interface RenderResult {
  url: string;
  html: string;
  statusCode: number;
  xRobotsTag?: string | null;
  finalUrl: string;
  diagnostics?: RenderDiagnostics;
}

// Diagnostics collected over a single render attempt, stored in R2 metadata for
// debugging snapshots from the dashboard.
type DiagnosticsCollector = {
  startedAt: number;
  failedRequests: { url: string; error: string }[];
  consoleErrors: string[];
  pageErrors: string[];
};

// R2 caps total object metadata at 8192 bytes, and values must be strings.
// Keep the diagnostics blobs well under that (worst case here is ~3KB across
// the three lists, leaving headroom for the url/userAgent/seo* keys). Counts
// are stored separately so a trimmed list stays distinguishable from a
// complete one.
export function renderDiagnosticsToMetadata(
  d: RenderDiagnostics,
): Record<string, string> {
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
  // R2 metadata is sent as HTTP headers, whose values must be Latin-1 printable
  // ASCII. Console/page-error text often carries emoji, curly quotes, CJK, etc.
  // JSON.stringify escapes control chars but leaves those raw, which trips
  // Node's ERR_INVALID_CHAR. Escaping every non-ASCII code unit to \uXXXX keeps
  // the string valid JSON while making it header-safe.
  const headerSafe = (s: string): string =>
    s.replace(
      /[^\x20-\x7E]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  const fitJsonArray = (items: unknown[], maxBytes: number): string => {
    const out: unknown[] = [];
    // Measure the header-safe (escaped) form so the byte budget reflects what
    // actually lands in the metadata header — escaping can grow a string up to
    // 6x, so budgeting on the raw JSON could overshoot R2's 8KB cap.
    for (const item of items) {
      if (headerSafe(JSON.stringify([...out, item])).length > maxBytes) break;
      out.push(item);
    }
    return headerSafe(JSON.stringify(out));
  };
  return {
    renderReadyReason: headerSafe(d.readyReason),
    renderDurationMs: String(d.durationMs),
    renderFailedRequestCount: String(d.failedRequests.length),
    renderFailedRequests: fitJsonArray(
      d.failedRequests.map((r) => ({
        url: trunc(r.url, 150),
        error: trunc(r.error, 60),
      })),
      1200,
    ),
    renderPendingRequestCount: String(d.pendingRequests.length),
    renderPendingRequests: fitJsonArray(
      d.pendingRequests.map((u) => trunc(u, 150)),
      800,
    ),
    renderConsoleErrorCount: String(d.consoleErrors.length),
    renderConsoleErrors: fitJsonArray(
      d.consoleErrors.map((s) => trunc(s, 200)),
      1000,
    ),
    renderPageErrorCount: String(d.pageErrors.length),
    renderPageErrors: fitJsonArray(
      d.pageErrors.map((s) => trunc(s, 200)),
      800,
    ),
  };
}

type ReadinessState = {
  appSignaled: boolean;
  networkIdleSince: number | null;
  domStableSince: number | null;
  heartbeatAtNetworkIdle: number | null;
};

export class RenderEngine {
  private readonly _url: string;
  private readonly _targetHost: string;
  private readonly _browser: Browser;
  private readonly _userAgent: string;
  private readonly _internalKey: string | null;
  private readonly _internalKeyHosts: Set<string>;
  private readonly _stabilityMultiplier: number;
  private readonly _assetCache: AssetCache | null;
  private readonly _requestStats: RequestStats | null;
  private readonly _logger: AppLogger;

  static register({
    targetUrl,
    browser,
    userAgent,
    internalKey,
    internalKeyHosts,
    extendedStability,
    assetCache,
    requestStats,
  }: {
    targetUrl: string;
    browser: Browser;
    userAgent: string;
    internalKey?: string;
    internalKeyHosts?: string[];
    // Widens the readiness quiet/stable windows 4x. Used when retrying a
    // render whose first attempt produced a loading-shell snapshot.
    extendedStability?: boolean;
    // Job-wide cache of the site's static assets; repeat requests are
    // answered from memory instead of re-hitting the customer's origin.
    assetCache?: AssetCache;
    // Job-wide tally of outbound/blocked requests for the end-of-run summary.
    requestStats?: RequestStats;
  }) {
    return new RenderEngine(
      targetUrl,
      browser,
      userAgent,
      internalKey ?? null,
      internalKeyHosts ?? [],
      extendedStability ?? false,
      assetCache ?? null,
      requestStats ?? null,
    );
  }

  private constructor(
    targetUrl: string,
    browser: Browser,
    userAgent: string,
    internalKey: string | null,
    internalKeyHosts: string[],
    extendedStability: boolean,
    assetCache: AssetCache | null,
    requestStats: RequestStats | null,
  ) {
    this._url = targetUrl;
    this._targetHost = getHostname(targetUrl) ?? "";
    this._browser = browser;
    this._userAgent = userAgent.trim();
    this._internalKey = internalKey;
    this._assetCache = assetCache;
    this._requestStats = requestStats;
    // Cover both apex and www forms so requests to either routing hostname
    // carry the key.
    this._internalKeyHosts = new Set(
      internalKeyHosts
        .map((h) => h.toLowerCase())
        .flatMap((h) =>
          h.startsWith("www.") ? [h, h.slice(4)] : [h, `www.${h}`],
        ),
    );
    this._stabilityMultiplier = extendedStability ? 4 : 1;
    this._logger = AppLogger.register({ prefix: "render-engine" });
  }

  async renderPage(): Promise<RenderResult> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RENDER_ATTEMPTS; attempt++) {
      const context = await this._browser.createBrowserContext();
      const page = await context.newPage();

      const diagnostics: DiagnosticsCollector = {
        startedAt: Date.now(),
        failedRequests: [],
        consoleErrors: [],
        pageErrors: [],
      };
      this.attachDebugListeners(page, diagnostics);

      try {
        return await Promise.race([
          this.renderPageInternal(page, diagnostics),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Render timed out after ${DEFAULT_RENDER_TIMEOUT}ms`,
                  ),
                ),
              DEFAULT_RENDER_TIMEOUT,
            ),
          ),
        ]);
      } catch (e) {
        lastError = e;
        const shouldRetry =
          attempt < MAX_RENDER_ATTEMPTS && this.isFrameDetachedError(e);

        if (shouldRetry) {
          this._logger.warn(
            `[Prerender] Frame detached while rendering ${this._url}; retrying with a fresh page`,
          );
          continue;
        }

        this._logger.error(
          `Failed to render page ${this._url}: ${e instanceof Error ? e.message : String(e)}`,
        );
        throw e;
      } finally {
        await page.close().catch((e) => {
          this._logger.debug("[Prerender] Failed to close page", e);
        });
        await context.close().catch((e) => {
          this._logger.debug("[Prerender] Failed to close context", e);
        });
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to render page ${this._url}`);
  }

  private attachDebugListeners(
    page: Page,
    diagnostics: DiagnosticsCollector,
  ): void {
    // Set up page event listeners for debugging (filtered to reduce noise)
    try {
      page.on("console", (msg: ConsoleMessage) => {
        try {
          const text = msg.text();
          // Skip noisy warnings about preload/crossorigin mismatches
          if (text.includes("preload") && text.includes("crossorigin")) return;
          // Only log errors, not warnings/info
          if (msg.type() === "error") {
            this._logger.debug(
              `[PageConsole] ${msg.type()}: ${text} : ${this._url}`,
            );
            if (diagnostics.consoleErrors.length < DIAG_MAX_ENTRIES) {
              diagnostics.consoleErrors.push(text);
            }
          }
        } catch {
          // ignore
        }
      });
      page.on("error", (err: unknown) => {
        if (err instanceof Error) {
          try {
            this._logger.debug(
              `[PageError] ${err?.message || err} - ${this._url}`,
            );
          } catch {
            // ignore
          }
        }
      });
      page.on("pageerror", (err: unknown) => {
        if (err instanceof Error) {
          try {
            const message = err?.message || String(err);
            this._logger.debug(`[PageError] ${message}`);
            if (diagnostics.pageErrors.length < DIAG_MAX_ENTRIES) {
              diagnostics.pageErrors.push(message);
            }
          } catch {
            // ignore
          }
        }
      });
      page.on("requestfailed", (req: HTTPRequest) => {
        try {
          const errorText = req.failure()?.errorText || "";
          // Skip non-critical failures (fonts, ORB blocks, analytics)
          if (
            errorText.includes("ERR_BLOCKED_BY_ORB") ||
            errorText.includes("ERR_ABORTED") ||
            req.url().includes("fonts.googleapis.com") ||
            req.url().includes("fonts.gstatic.com") ||
            req.url().includes("fonts.reown.com") ||
            req.url().includes("analytics") ||
            req.url().includes("gtag")
          ) {
            return;
          }
          this._logger.debug("[RequestFailed]", req.url(), errorText);
          if (diagnostics.failedRequests.length < DIAG_MAX_ENTRIES) {
            diagnostics.failedRequests.push({
              url: req.url(),
              error: errorText,
            });
          }
        } catch {
          // ignore
        }
      });
    } catch (e) {
      this._logger.debug(
        "[Prerender] Failed to attach page event listeners",
        e,
      );
    }
  }

  private isFrameDetachedError(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    return (
      msg.includes("frame was detached") ||
      msg.includes("Navigating frame was detached") ||
      msg.includes("Target closed") ||
      msg.includes("context was destroyed") ||
      msg.includes("Execution context was destroyed")
    );
  }

  private async renderPageInternal(
    page: Page,
    diagnostics: DiagnosticsCollector,
  ): Promise<RenderResult> {
    const tracer = RenderTracer.enabled()
      ? RenderTracer.register({ url: this._url, page, logger: this._logger })
      : null;
    if (tracer) {
      await tracer.start();
    }

    try {
      return await this.renderPageInternalTraced(page, tracer, diagnostics);
    } finally {
      if (tracer) {
        await tracer.stop().catch(() => void 0);
      }
    }
  }

  private async renderPageInternalTraced(
    page: Page,
    tracer: RenderTracer | null,
    diagnostics: DiagnosticsCollector,
  ): Promise<RenderResult> {
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent({ userAgent: this._userAgent });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });
    await this.injectPrerenderScripts({ page });

    // Intercept requests to add the internal header only to same-origin requests,
    // avoiding CORS preflight failures on third-party domains.
    const targetHost = this._targetHost;
    await page.setRequestInterception(true);

    // Detect navigation loops (e.g., infinite redirect between routes)
    let navigationCount = 0;
    page.on("framenavigated", (frame) => {
      this._logger.debug(`[FrameNavigated] ${frame.url()}`);
      const frameHost = getHostname(frame.url());
      if (frameHost !== targetHost) {
        return;
      }
      if (frame.parentFrame() !== null) {
        return;
      }
      navigationCount++;
      if (navigationCount > MAX_NAVIGATIONS) {
        this._logger.debug(
          `[Prerender] Navigation loop detected (${navigationCount} navigations), aborting JS execution`,
        );
        void page.close().catch(() => void 0);
      }
    });

    // Attach request tracker before navigation so requests during page.goto are captured
    const firstPartyReqPending = new Set<HTTPRequest>();
    const outgoingRequests = new Set<HTTPRequest>();

    page.on("request", (req: HTTPRequest) => {
      let url: URL;
      try {
        url = new URL(req.url());
      } catch {
        return;
      }

      const resourceType = req.resourceType() as unknown as string;

      // Serve repeat static-asset requests from the job-wide cache so each
      // bundle/stylesheet/font/image hits the origin once per job, not once
      // per render. Cache-served requests never reach the network, so they
      // skip the pending-request tracking below.
      if (this._assetCache && req.method() === "GET") {
        const cached = this._assetCache.get(req.url());
        if (cached) {
          req
            .respond({
              status: 200,
              contentType: cached.contentType,
              headers: cached.corsHeaders,
              body: cached.body,
            })
            .catch(() => void 0);
          return;
        }
      }

      // Add the internal prerender header only to same-origin requests
      const reqHost = url.hostname;
      const headers = req.headers();
      if (reqHost === targetHost) {
        headers[INTERNAL_PRERENDER_HEADER] = "1";
      }
      if (
        this._internalKey &&
        (reqHost === targetHost || this._internalKeyHosts.has(reqHost))
      ) {
        headers[ENCITED_INTERNAL_KEY_HEADER] = this._internalKey;
      }
      const isCustomerHost =
        reqHost === targetHost || this._internalKeyHosts.has(reqHost);
      this._requestStats?.countOutbound({ isCustomerHost });
      // Reaching here with a cacheable asset means the cache was probed above
      // and missed — count it so the hit-rate denominator is honest.
      if (
        this._assetCache &&
        isCustomerHost &&
        req.method() === "GET" &&
        CACHEABLE_ASSET_TYPES.has(resourceType)
      ) {
        this._assetCache.countMiss();
      }
      req.continue({ headers }).catch(() => {
        // If continue fails (e.g. request already handled), ignore
        return void 0;
      });

      outgoingRequests.add(req);

      try {
        if (this.shouldTrackReq({ req, targetHost, path: url.pathname })) {
          firstPartyReqPending.add(req);
        }
      } catch {
        void 0;
      }
    });

    const settle = (req: HTTPRequest) => {
      if (outgoingRequests.has(req)) {
        this._logger.debug(
          `[Prerender] Request ${req.url()} settled for ${this._url}`,
        );
      }
      outgoingRequests.delete(req);
      try {
        firstPartyReqPending.delete(req);
      } catch {
        void 0;
      }
    };
    page.on("requestfinished", settle);
    page.on("requestfailed", settle);

    if (this._assetCache) {
      page.on("response", (res: HTTPResponse) => {
        this.maybeCacheAsset(res).catch(() => void 0);
      });
    }

    const navStartTimestamp = Date.now();
    this._logger.debug(`[Prerender] Navigating to ${this._url}`);
    let response;
    try {
      response = await page.goto(this._url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
    } catch (e) {
      if (tracer) {
        await tracer
          .snapshot(
            `goto-failed after ${Date.now() - navStartTimestamp}ms: ${e instanceof Error ? e.message : String(e)}`,
          )
          .catch(() => void 0);
      }
      throw e;
    }
    const navEndTimestamp = Date.now();
    this._logger.debug(
      `[Prerender] Navigation completed in ${navEndTimestamp - navStartTimestamp}ms for ${this._url}`,
    );

    const readyReason = await this.waitForPageReady({
      page,
      firstPartyReqPending,
    });
    this._logger.debug(`[Prerender] Snapshot triggered by: ${readyReason}`);
    if (!response) {
      throw new Error(`Failed to navigate to ${this._url}`);
    }

    if (outgoingRequests.size > 0) {
      this._logger.debug(
        "Unresolved requests:",
        JSON.stringify(
          Array.from(outgoingRequests).map((req) => req.url()),
          null,
          2,
        ),
      );
    }

    const statusCode = response.status();

    // Error pages (4xx/5xx) are never cached; the status rides on the error
    // so the batch report can distinguish deterministic 404s from transient 5xx.
    if (statusCode >= 400) {
      throw new RenderFailureError(
        `Origin returned ${statusCode} for ${this._url}`,
        { reason: "fetch_error", status: statusCode },
      );
    }

    if (navigationCount > MAX_NAVIGATIONS) {
      throw new RenderFailureError(
        `Navigation loop detected for ${this._url}: ${navigationCount} navigations (final URL: ${page.url()})`,
        { reason: "navigation_loop" },
      );
    }

    const html = await page.content();
    const xRobotsTag = response.headers()["x-robots-tag"] ?? null;
    const finalUrl = page.url();

    return {
      url: this._url,
      html,
      statusCode,
      xRobotsTag,
      finalUrl,
      diagnostics: {
        readyReason,
        durationMs: Date.now() - diagnostics.startedAt,
        failedRequests: diagnostics.failedRequests,
        pendingRequests: Array.from(firstPartyReqPending, (req) => req.url()),
        consoleErrors: diagnostics.consoleErrors,
        pageErrors: diagnostics.pageErrors,
      },
    };
  }

  private async maybeCacheAsset(res: HTTPResponse): Promise<void> {
    const cache = this._assetCache;
    if (!cache) {
      return;
    }
    const req = res.request();
    const url = req.url();
    if (req.method() !== "GET" || cache.has(url)) {
      return;
    }
    if (!CACHEABLE_ASSET_TYPES.has(req.resourceType() as unknown as string)) {
      return;
    }
    // Only complete 200 bodies — redirects, 304s and partial responses can't
    // be replayed. Service-worker-mediated bodies are skipped because the
    // worker may have rewritten them.
    if (res.status() !== 200 || res.fromServiceWorker()) {
      return;
    }
    // Cache only the customer's own hosts — that's whose origin we're
    // protecting, and it bounds the cache to one site's asset set.
    const host = getHostname(url);
    if (
      !host ||
      (host !== this._targetHost && !this._internalKeyHosts.has(host))
    ) {
      return;
    }
    const resHeaders = res.headers();
    // A 200 with an HTML body for a script/stylesheet/font/image URL is the
    // signature of a WAF challenge, error page, or mid-deploy hiccup — never
    // a real asset. Caching it would replay the broken body into every
    // remaining render of the job, so let each render fetch it fresh instead.
    const contentType = (resHeaders["content-type"] ?? "").toLowerCase();
    if (contentType.includes("text/html")) {
      this._logger.debug(
        `[AssetCache] Not caching ${url}: HTML body for a ${req.resourceType()} request`,
      );
      return;
    }
    const body = await res.buffer().catch(() => null);
    if (!body || body.length === 0) {
      return;
    }
    const corsHeaders: Record<string, string> = {};
    for (const name of [
      "access-control-allow-origin",
      "access-control-allow-credentials",
    ]) {
      const value = resHeaders[name];
      if (value) {
        corsHeaders[name] = value;
      }
    }
    cache.put(url, {
      body,
      contentType: resHeaders["content-type"] ?? "application/octet-stream",
      corsHeaders,
    });
  }

  private shouldTrackReq({
    req,
    targetHost,
    path,
  }: {
    req: HTTPRequest;
    targetHost: string;
    path: string;
  }): boolean {
    const trackResourceTypes = new Set([
      "document",
      "script",
      "xhr",
      "fetch",
      "stylesheet",
      "image",
    ]);
    try {
      const host = getHostname(req.url());
      if (!host) {
        return false;
      }

      if (this.isIgnoredHost(host) || this.isIgnoredPath(path)) {
        this._logger.debug(`[Prerender] Ignoring request to ${req.url()}`);
        return false;
      }

      const resourceType = req.resourceType() as unknown as string;

      // Always track fetch/xhr regardless of host — SPAs often fetch from
      // API subdomains (api.example.com) or third-party headless CMS endpoints
      if (resourceType === "fetch" || resourceType === "xhr") {
        return true;
      }

      // For other resource types, only track first-party
      if (host !== targetHost) {
        return false;
      }

      return trackResourceTypes.has(resourceType);
    } catch {
      return false;
    }
  }

  private isIgnoredPath(path: string): boolean {
    // Telemetry served from the customer's own hostname — it loads normally
    // but must not gate the snapshot: a hanging beacon would otherwise hold
    // first-party pending requests open and ride every render to the hard
    // timeout. ~flock.js and /__l5e/ (events.js, trackevents) are Lovable's
    // injected analytics.
    const ignoredPaths = ["fb-conversions-api", "~flock.js", "__l5e/"];
    return ignoredPaths.some((p) => path.includes(p));
  }

  private isIgnoredHost(host: string): boolean {
    // Domains to ignore for network idle detection (analytics, fonts, ads)
    const ignoredHosts = [
      "google.com",
      "google.co.uk",
      "google-analytics.com",
      "googletagmanager.com",
      "fonts.googleapis.com",
      "fonts.gstatic.com",
      "fonts.reown.com",
      "www.googletagmanager.com",
      "analytics.google.com",
      "facebook.com",
      "www.facebook.com",
      "connect.facebook.net",
      "brilliantlocco.com",
      "doubleclick.net",
      "googlesyndication.com",
      "hotjar.com",
      "hotjar.io",
      "clarity.ms",
      "segment.io",
      "segment.com",
      "mixpanel.com",
      "amplitude.com",
      "posthog.com",
      "intercom.io",
      "crisp.chat",
      "sentry.io",
      "tawk.to",
      "drift.com",
      "zendesk.com",
      "hubspot.com",
      "hs-analytics.net",
      "hs-scripts.com",
      "freshdesk.com",
      "livechatinc.com",
      "fullstory.com",
      "heap.io",
      "heapanalytics.com",
      "logrocket.com",
      "mouseflow.com",
      "optimizely.com",
      "cloudflareinsights.com",
      "radar.snitcher.com",
      "liadm.com",
      "js.zi-scripts.com",
      "ads.linkedin.com",
      "kular.ai",
      "mapbox.com",
      "chatwhisperer.ai",
    ];
    return ignoredHosts.some((h) => host === h || host.endsWith(`.${h}`));
  }

  private async checkAppSignal({ page }: { page: Page }): Promise<boolean> {
    try {
      const result = await Promise.race([
        page.evaluate(() => {
          // @ts-expect-error - custom window properties
          const ready = window.prerenderReady as boolean;
          // @ts-expect-error - custom window properties
          const snapshot = window.htmlSnapshot as boolean;
          return ready === true || snapshot === true;
        }),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 1000),
        ),
      ]);

      return result;
    } catch {
      return false;
    }
  }

  private async getLastDomChange({ page }: { page: Page }): Promise<number> {
    try {
      const result = await Promise.race([
        page.evaluate(() => {
          // @ts-expect-error - custom window properties
          return (window.__lastDomChange ?? Date.now()) as number;
        }),
        new Promise<number>((resolve) =>
          setTimeout(() => resolve(Date.now()), 1000),
        ),
      ]);

      return result;
    } catch {
      return Date.now();
    }
  }

  private async getHeartbeatTick({
    page,
  }: {
    page: Page;
  }): Promise<number | null> {
    try {
      const result = await Promise.race([
        page.evaluate(() => {
          // @ts-expect-error - custom window properties
          return (window.__heartbeatTick ?? null) as number | null;
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
      ]);

      return result;
    } catch {
      return null;
    }
  }

  private async injectPrerenderScripts({
    page,
  }: {
    page: Page;
  }): Promise<void> {
    // Inject prerender signals and DOM stability tracking
    try {
      if (typeof page.evaluateOnNewDocument === "function") {
        await page.evaluateOnNewDocument(() => {
          try {
            // @ts-expect-error - custom window properties
            window.__TO_HTML = true;
            // @ts-expect-error - custom window properties
            window.__lastDomChange = Date.now();

            // Main-thread heartbeat. A renderer starved of CPU (e.g. module
            // evaluation of a lazy route chunk while sibling renders hog the
            // container) can't service timers, so a stalled counter tells the
            // readiness poll that "quiet network + static DOM" just means the
            // page hasn't had CPU time to render yet.
            // @ts-expect-error - custom window properties
            window.__heartbeatTick = 0;
            setInterval(() => {
              // @ts-expect-error - custom window properties
              window.__heartbeatTick++;
            }, 100);

            const setup = () => {
              // Disable CSS animations/transitions to prevent continuous DOM mutations
              const head = document.head || document.documentElement;
              if (head) {
                const style = document.createElement("style");
                style.textContent =
                  "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; animation-delay: 0s !important; transition-delay: 0s !important; }";
                head.appendChild(style);
              }

              if (document.documentElement) {
                const observer = new MutationObserver((mutations) => {
                  for (const m of mutations) {
                    // Ignore inline style writes — JS animation libs (Framer
                    // Motion, GSAP, Motion One) write transform/opacity every
                    // frame and would otherwise pin DOM as "never idle".
                    if (m.type === "attributes" && m.attributeName === "style")
                      continue;
                    // @ts-expect-error - custom window properties
                    window.__lastDomChange = Date.now();
                    return;
                  }
                });
                observer.observe(document.documentElement, {
                  childList: true,
                  subtree: true,
                  attributes: true,
                  characterData: true,
                });
              }
            };

            if (document.documentElement) {
              setup();
            } else {
              document.addEventListener("DOMContentLoaded", setup);
            }
          } catch (e) {
            console.error("[Prerender] Failed to inject prerender scripts", e);
          }
        });
      }
    } catch (e) {
      this._logger.debug("[Prerender] Error setting prerender init script", e);
    }
  }

  private async hasHeadMetadata({ page }: { page: Page }): Promise<boolean> {
    try {
      return await Promise.race([
        page.evaluate(() => {
          return !!(
            document.querySelector("title")?.textContent ||
            document.querySelector('meta[data-rh="true"]') ||
            document.querySelector("meta[data-react-helmet]")
          );
        }),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 1000),
        ),
      ]);
    } catch {
      return false;
    }
  }

  private async waitForPageReady({
    page,
    firstPartyReqPending,
  }: {
    page: Page;
    firstPartyReqPending: Set<HTTPRequest>;
  }): Promise<string> {
    // Readiness detection constants
    const HARD_TIMEOUT_MS = 30_000;
    const NETWORK_QUIET_MS = 500 * this._stabilityMultiplier;
    const DOM_STABLE_MS = 500 * this._stabilityMultiplier;
    const POLL_INTERVAL_MS = 400;
    // After network+DOM are stable, wait an extra period for a final DOM
    // settle before taking the snapshot (covers late Helmet injections).
    const POST_READY_SETTLE_MS = 300 * this._stabilityMultiplier;
    // Minimum injected-heartbeat ticks (100ms each) that must elapse after
    // the network goes quiet before "stable" is believable — proves the
    // renderer's main thread actually got CPU time to turn any downloaded
    // code into DOM, instead of being starved mid-boot.
    const MIN_HEARTBEAT_TICKS_SINCE_IDLE = 3;

    const startedAt = Date.now();
    const state: ReadinessState = {
      appSignaled: false,
      networkIdleSince: null,
      domStableSince: null,
      heartbeatAtNetworkIdle: null,
    };

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let pendingTimeout: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (pendingTimeout) {
          clearTimeout(pendingTimeout);
          pendingTimeout = null;
        }
      };
      const settleResolve = (value: string) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };
      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      // Track when the underlying signal (network+DOM / app_signaled) first fired
      // so we can log it, but metadata is the gate for actually resolving.
      let signalReason: string | null = null;
      let signalFiredAt: number | null = null;

      const tick = async () => {
        if (settled) {
          return;
        }

        const now = Date.now();
        const elapsed = now - startedAt;

        // Hard timeout — snapshot regardless of metadata
        if (elapsed >= HARD_TIMEOUT_MS) {
          this._logger.debug(
            "[Prerender] Hard timeout reached, taking snapshot",
          );
          return settleResolve("hard_timeout");
        }

        // ── Check metadata (title) every tick ──
        // Metadata is a first-class readiness requirement, not a post-check.
        const hasMetadata = await this.hasHeadMetadata({ page });

        // ── Check underlying signals ──
        let signalReady = signalReason !== null;

        // Record the app's readiness signal, but don't trust it on its own.
        // The app can set prerenderReady before its own data fetch resolves
        // (the skeleton race), so we still wait for first-party requests to go
        // quiet below before treating the signal as ready.
        if (!state.appSignaled && (await this.checkAppSignal({ page }))) {
          state.appSignaled = true;
          this._logger.debug(
            "[Prerender] App signaled ready via prerenderReady/htmlSnapshot",
          );
        }

        if (!signalReady) {
          if (firstPartyReqPending.size === 0) {
            if (state.networkIdleSince === null) {
              state.networkIdleSince = now;
              state.heartbeatAtNetworkIdle = await this.getHeartbeatTick({
                page,
              });
            }
          } else {
            state.networkIdleSince = null;
            state.heartbeatAtNetworkIdle = null;
          }

          const lastDomChange = await this.getLastDomChange({ page });
          const domIdleTime = now - lastDomChange;
          if (domIdleTime >= DOM_STABLE_MS) {
            if (state.domStableSince === null) {
              state.domStableSince = now;
            }
          } else {
            state.domStableSince = null;
          }

          const networkIdleDuration =
            state.networkIdleSince !== null ? now - state.networkIdleSince : 0;
          let networkStable = networkIdleDuration >= NETWORK_QUIET_MS;
          if (networkStable && state.heartbeatAtNetworkIdle !== null) {
            const heartbeat = await this.getHeartbeatTick({ page });
            if (
              heartbeat !== null &&
              heartbeat - state.heartbeatAtNetworkIdle <
                MIN_HEARTBEAT_TICKS_SINCE_IDLE
            ) {
              this._logger.debug(
                `[Prerender] Network quiet but renderer main thread stalled (${heartbeat - state.heartbeatAtNetworkIdle} heartbeat ticks since idle), holding snapshot`,
              );
              networkStable = false;
            }
          }
          const domStable = state.domStableSince !== null;

          // Trust the app signal only once first-party requests have gone
          // quiet — by then React has painted the content. DOM stability isn't
          // required here because the app has explicitly declared readiness.
          if (state.appSignaled && networkStable) {
            signalReady = true;
            signalReason = "app_signaled";
            signalFiredAt = now;
            this._logger.debug(
              `[Prerender] App signaled and network idle for ${networkIdleDuration}ms`,
            );
          } else if (networkStable && domStable) {
            signalReady = true;
            signalReason = `network_and_dom_stable (network idle ${networkIdleDuration}ms, DOM stable ${domIdleTime}ms)`;
            signalFiredAt = now;
          }

          const MIN_WAIT_MS = 500;
          const DOM_EXTENDED_WAIT_MS = 3000;
          if (elapsed >= MIN_WAIT_MS && networkStable) {
            if (elapsed >= MIN_WAIT_MS + DOM_EXTENDED_WAIT_MS) {
              signalReady = true;
              signalReason = "network_stable_dom_timeout";
              signalFiredAt = now;
            }
          }
        }

        // ── Resolution logic ──
        // Both metadata AND an underlying signal must be satisfied.
        // Metadata alone isn't enough (page might still be loading).
        // Signal alone isn't enough (title may not have been injected yet).
        if (hasMetadata && signalReady) {
          // Wait a short settle period after both conditions are met so
          // remaining meta tags (description, og:*) finish injecting.
          const lastDomChange = await this.getLastDomChange({ page });
          const domSettled = now - lastDomChange >= POST_READY_SETTLE_MS;
          if (domSettled) {
            this._logger.debug(`[Prerender] Page ready: ${signalReason}`);
            return settleResolve(signalReason ?? "ready");
          }
        }

        // Metadata present but no signal yet — keep waiting for signal
        // Signal present but no metadata — keep polling for metadata
        if (signalReady && !hasMetadata && signalFiredAt !== null) {
          // Log once when we start waiting for metadata
          if (now - signalFiredAt < POLL_INTERVAL_MS * 2) {
            this._logger.debug(
              `[Prerender] Signal ready (${signalReason}) but head metadata missing, will keep polling until hard timeout`,
            );
          }
        }

        pendingTimeout = setTimeout(
          () => void tick().catch((e: Error) => settleReject(e)),
          POLL_INTERVAL_MS,
        );
      };
      tick().catch((e: Error) => settleReject(e));
    });
  }
}
