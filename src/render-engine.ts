import {
  Browser,
  ConsoleMessage,
  HTTPRequest,
  HTTPResponse,
  Page,
} from "puppeteer-core";
import { getHostname } from "tldts";
import { normalizeTokenHost } from "./util";
import { AssetCache } from "./asset-cache";
import { BeaconDetector, type BeaconRenderSession } from "./beacon-detector";
import { isIgnoredHost, isIgnoredPath } from "./ignored-endpoints";
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
const RENDER_TOKEN_HEADER = "x-encited-token";

/** Case-insensitive, because a redirected request keeps the previous hop's casing. */
function deleteHeader(headers: Record<string, string>, lowercaseName: string) {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === lowercaseName) delete headers[name];
  }
}

/**
 * The token to send to this URL, or null. Callers must strip on null, not just
 * skip: a redirected request arrives holding the previous hop's headers.
 */
export function renderTokenFor(
  url: URL,
  hosts: ReadonlySet<string>,
  token: string | null,
): string | null {
  if (!token) return null;
  if (url.protocol !== "https:") return null;
  return hosts.has(normalizeTokenHost(url.hostname)) ? token : null;
}
const MAX_NAVIGATIONS = 10;
// Throttle for probe-timeout logs: a wedged renderer times out every probe of
// every tick, and one line per occurrence would bury the rest of the render log.
const PROBE_TIMEOUT_LOG_INTERVAL_MS = 5_000;
const MAX_RENDER_ATTEMPTS = 2;
// A tracked request still in flight after this long is a long-poll (PubNub,
// Turnstile challenges), a request orphaned by a redirect, or simply hung —
// it stops gating network idle but stays in the pending set for diagnostics.
// Anything that would have finished inside 15s is unaffected. Scaled by the
// stability multiplier so the extended-stability retry (triggered by a thin
// first snapshot) waits out genuinely slow data fetches instead of hitting
// the same cliff: at 4x the cap exceeds the hard timeout, i.e. the retry
// never ages requests out.
//
// Accepted risk: a data call slower than the cap is retired, so its render
// can resolve network_and_dom_stable on a partially-filled page without
// being flagged degraded. The retired requests are listed in the
// renderPendingRequests diagnostic, and a capture thin enough to look like a
// failed render still gets the 4x retry.
export const PENDING_MAX_AGE_MS = 15_000;
// ── Readiness tuning. NETWORK_QUIET_MS, DOM_STABLE_MS, POST_READY_SETTLE_MS
// and PENDING_MAX_AGE_MS are multiplied by the engine's stability multiplier
// (4x on the extended-stability retry). Everything else here is absolute,
// MIN_WAIT_MS/DOM_EXTENDED_WAIT_MS included — evaluateReadySignal is
// module-level and has no multiplier, so the retry does not widen the
// network_stable_dom_timeout fallback.
const HARD_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 400;
const NETWORK_QUIET_MS = 500;
const DOM_STABLE_MS = 500;
// After network+DOM are stable, wait an extra period for a final DOM settle
// before snapshotting (covers late Helmet injections).
const POST_READY_SETTLE_MS = 300;
// Minimum injected-heartbeat ticks (100ms each) after the network goes quiet
// before "stable" is believable — proves the renderer's main thread got CPU
// time to turn downloaded code into DOM instead of being starved mid-boot.
const MIN_HEARTBEAT_TICKS_SINCE_IDLE = 3;
// Floor before any heuristic capture, and how much longer a network-stable
// page waits for its DOM to settle before we snapshot anyway.
const MIN_WAIT_MS = 500;
const DOM_EXTENDED_WAIT_MS = 3_000;

/**
 * Whether a request should gate readiness. fetch/xhr count from any host —
 * SPAs fetch from API subdomains and third-party CMS endpoints — while other
 * types only count first-party. Statically-ignored hosts and paths never do.
 */
export function shouldTrackRequest({
  resourceType,
  host,
  path,
  targetHost,
}: {
  resourceType: string;
  host: string;
  path: string;
  targetHost: string;
}): boolean {
  if (!host || isIgnoredHost(host) || isIgnoredPath(path)) {
    return false;
  }
  if (resourceType === "fetch" || resourceType === "xhr") {
    return true;
  }
  return host === targetHost && TRACKED_RESOURCE_TYPES.has(resourceType);
}

const TRACKED_RESOURCE_TYPES = new Set([
  "document",
  "script",
  "xhr",
  "fetch",
  "stylesheet",
  "image",
]);

/** Signal half of a readiness verdict, before the metadata gate. */
type ReadySignal = { reason: ReadyReason; detail?: string };

/**
 * Tracked requests that still gate network idle, and the beacon endpoints
 * skipped. Both classes stay in the caller's map for the pendingRequests
 * diagnostic: beacon-classified endpoints (checked live, so a verdict from
 * any concurrent pipeline applies at once) and requests older than the age
 * cap — long-polls, hung data calls, and requests orphaned by a redirect.
 */
export function countActivePending({
  pending,
  now,
  readinessStartedAt,
  maxAgeMs,
  isBeaconKey,
}: {
  pending: Map<HTTPRequest, PendingRequestInfo>;
  now: number;
  readinessStartedAt: number;
  maxAgeMs: number;
  isBeaconKey: (key: string) => boolean;
}): { count: number; suppressedBeaconKeys: string[] } {
  let count = 0;
  const suppressed = new Set<string>();
  for (const { startedAt, key } of pending.values()) {
    if (key !== null && isBeaconKey(key)) {
      suppressed.add(key);
      continue;
    }
    // Age from the later of request start and readiness start: requests
    // issued during a slow page.goto are already old by the first tick, and
    // still deserve the full grace period.
    if (now - Math.max(startedAt, readinessStartedAt) < maxAgeMs) {
      count++;
    }
  }
  return { count, suppressedBeaconKeys: Array.from(suppressed) };
}

/**
 * The readiness verdict from one tick's measurements, or null to keep
 * waiting. A defined-but-false readiness flag means the app calls itself
 * mid-load, so the stability fallbacks stay disabled until it flips (or the
 * caller's hard timeout fires) — otherwise they capture its loading shell.
 */
export function evaluateReadySignal({
  elapsed,
  appSignaled,
  flagDefined,
  networkStable,
  domStable,
  networkIdleMs,
  domIdleMs,
}: {
  elapsed: number;
  appSignaled: boolean;
  flagDefined: boolean;
  networkStable: boolean;
  domStable: boolean;
  networkIdleMs: number;
  domIdleMs: number;
}): ReadySignal | null {
  // Trust the app signal only once first-party requests have gone quiet — by
  // then React has painted. DOM stability isn't required: the app has
  // explicitly declared readiness.
  if (appSignaled && networkStable) {
    return {
      reason: "app_signaled",
      detail: `network idle ${networkIdleMs}ms`,
    };
  }
  if (flagDefined && !appSignaled) {
    return null;
  }
  if (networkStable && domStable) {
    return {
      reason: "network_and_dom_stable",
      detail: `network idle ${networkIdleMs}ms, DOM stable ${domIdleMs}ms`,
    };
  }
  if (networkStable && elapsed >= MIN_WAIT_MS + DOM_EXTENDED_WAIT_MS) {
    return { reason: "network_stable_dom_timeout" };
  }
  return null;
}

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

/** What ended the readiness wait (see waitForPageReady). */
export type ReadyReason =
  | "app_signaled"
  | "network_and_dom_stable"
  | "network_stable_dom_timeout"
  | "hard_timeout"
  | "hard_timeout_not_ready";

/** A readiness verdict plus the measurements behind it, for diagnostics. */
export type ReadyOutcome = {
  reason: ReadyReason;
  detail?: string;
  /** Beacon endpoints suppressed from the idle computation this render. */
  suppressedBeaconKeys: string[];
};

export type RenderDiagnostics = {
  readyReason: ReadyReason;
  /** Measurements behind the reason, e.g. "network idle 800ms". */
  readyDetail?: string;
  // Wall-clock from render start to snapshot, in ms.
  durationMs: number;
  failedRequests: { url: string; error: string }[];
  // First-party requests still in flight when the snapshot was taken — useful
  // for diagnosing hard_timeout / dom_timeout snapshots (what was hanging).
  pendingRequests: string[];
  consoleErrors: string[];
  pageErrors: string[];
  // 429 responses on xhr/fetch data calls (non-ignored hosts) during the
  // render — the origin-under-pressure signal batch reports aggregate.
  throttledRequestCount: number;
  // Beacon endpoints whose tracked requests were actually suppressed from
  // readiness gating this render. Statically-ignored ones never appear —
  // they are filtered before tracking.
  beaconEndpoints: string[];
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
  throttledRequestCount: number;
};

/**
 * A render whose page had to be captured without the app's ready signal, or
 * whose data calls were rate-limited mid-render. Batch reports count these so
 * the worker can step an overloaded domain's concurrency down.
 */
export function isDegradedRender({
  readyReason,
  throttledRequestCount,
}: {
  /** Undefined when the render produced no diagnostics; never degraded. */
  readyReason: ReadyReason | undefined;
  throttledRequestCount: number;
}): boolean {
  return (
    readyReason === "hard_timeout" ||
    readyReason === "hard_timeout_not_ready" ||
    throttledRequestCount > 0
  );
}

// R2 caps total object metadata at 8192 bytes, and values must be strings.
// Keep the diagnostics blobs well under that (worst case here is ~4.2KB
// across the five lists, leaving headroom for the url/userAgent/seo* keys).
// Counts are stored separately so a trimmed list stays distinguishable from
// a complete one.
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
  // Each list gets a count key (so a trimmed list stays distinguishable from
  // a complete one) and a byte budget; the budgets total ~4.2KB.
  const lists = [
    {
      countKey: "renderFailedRequestCount",
      listKey: "renderFailedRequests",
      items: d.failedRequests.map((r) => ({
        url: trunc(r.url, 150),
        error: trunc(r.error, 60),
      })),
      maxBytes: 1200,
    },
    {
      countKey: "renderPendingRequestCount",
      listKey: "renderPendingRequests",
      items: d.pendingRequests.map((u) => trunc(u, 150)),
      maxBytes: 800,
    },
    {
      countKey: "renderConsoleErrorCount",
      listKey: "renderConsoleErrors",
      items: d.consoleErrors.map((e) => trunc(e, 200)),
      maxBytes: 1000,
    },
    {
      countKey: "renderPageErrorCount",
      listKey: "renderPageErrors",
      items: d.pageErrors.map((e) => trunc(e, 200)),
      maxBytes: 800,
    },
    {
      countKey: "renderBeaconEndpointCount",
      listKey: "renderBeaconEndpoints",
      items: d.beaconEndpoints.map((e) => trunc(e, 120)),
      maxBytes: 400,
    },
  ];
  const metadata: Record<string, string> = {
    renderReadyReason: d.readyReason,
    renderReadyDetail: headerSafe(d.readyDetail ?? ""),
    renderDurationMs: String(d.durationMs),
    renderThrottledRequestCount: String(d.throttledRequestCount),
  };
  for (const { countKey, listKey, items, maxBytes } of lists) {
    metadata[countKey] = String(items.length);
    metadata[listKey] = fitJsonArray(items, maxBytes);
  }
  return metadata;
}

/** One tracked in-flight request, as the idle computation sees it. */
type PendingRequestInfo = {
  startedAt: number;
  /** Beacon endpoint key (xhr/fetch only), or null. */
  key: string | null;
};

/** Per-render state shared by the request/response handlers and readiness. */
type RenderContext = {
  /** Tracked in-flight requests; readiness decides which of them still gate. */
  firstPartyReqPending: Map<HTTPRequest, PendingRequestInfo>;
  /** Everything on the wire, for the unresolved-requests diagnostic. */
  outgoingRequests: Set<HTTPRequest>;
  beaconSession: BeaconRenderSession | null;
  readinessSignal: ReadinessSignal;
  /** Main-frame navigations to the target host; a loop above MAX_NAVIGATIONS. */
  navigationCount: number;
};

/** Readiness state the request/response handlers need to see mid-render. */
export type ReadinessSignal = {
  /** When the DOM was first observed continuously stable, else null. */
  domStableSince: number | null;
};

type ReadinessState = {
  appSignaled: boolean;
  // The page defined window.prerenderReady/htmlSnapshot (any value). Once
  // defined, the app owns readiness: heuristic capture paths are suppressed
  // and only the flag flipping true (or the hard timeout failing the render)
  // ends the wait.
  flagDefined: boolean;
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
  private readonly _renderToken: string | null;
  private readonly _renderTokenHosts: Set<string>;
  private readonly _internalKeyHosts: Set<string>;
  private readonly _stabilityMultiplier: number;
  private readonly _assetCache: AssetCache | null;
  private readonly _requestStats: RequestStats | null;
  private readonly _beaconDetector: BeaconDetector | null;
  private readonly _logger: AppLogger;
  private _probeTimeouts = 0;
  private _lastProbeTimeoutLogAt = 0;

  static register({
    targetUrl,
    browser,
    userAgent,
    internalKey,
    renderToken,
    renderTokenHosts,
    internalKeyHosts,
    extendedStability,
    assetCache,
    requestStats,
    beaconDetector,
  }: {
    targetUrl: string;
    browser: Browser;
    userAgent: string;
    internalKey?: string;
    renderToken?: string;
    renderTokenHosts?: string[];
    internalKeyHosts?: string[];
    // Widens the readiness quiet/stable windows 4x. Used when retrying a
    // render whose first attempt produced a loading-shell snapshot.
    extendedStability?: boolean;
    // Job-wide cache of the site's static assets; repeat requests are
    // answered from memory instead of re-hitting the customer's origin.
    assetCache?: AssetCache;
    // Job-wide tally of outbound/blocked requests for the end-of-run summary.
    requestStats?: RequestStats;
    // Job-wide behavioral beacon classification; classified endpoints stop
    // gating readiness (their requests still load normally).
    beaconDetector?: BeaconDetector;
  }) {
    return new RenderEngine(
      targetUrl,
      browser,
      userAgent,
      internalKey ?? null,
      renderToken ?? null,
      renderTokenHosts ?? [],
      internalKeyHosts ?? [],
      extendedStability ?? false,
      assetCache ?? null,
      requestStats ?? null,
      beaconDetector ?? null,
    );
  }

  private constructor(
    targetUrl: string,
    browser: Browser,
    userAgent: string,
    internalKey: string | null,
    renderToken: string | null,
    renderTokenHosts: string[],
    internalKeyHosts: string[],
    extendedStability: boolean,
    assetCache: AssetCache | null,
    requestStats: RequestStats | null,
    beaconDetector: BeaconDetector | null,
  ) {
    this._url = targetUrl;
    this._targetHost = normalizeTokenHost(getHostname(targetUrl) ?? "");
    this._browser = browser;
    this._userAgent = userAgent.trim();
    this._internalKey = internalKey;
    this._renderToken = renderToken;
    this._renderTokenHosts = new Set(
      renderTokenHosts.map(normalizeTokenHost).filter((h) => h.length > 0),
    );
    this._assetCache = assetCache;
    this._requestStats = requestStats;
    this._beaconDetector = beaconDetector;
    // Cover both apex and www forms so requests to either routing hostname
    // carry the key.
    this._internalKeyHosts = new Set(
      internalKeyHosts
        .map(normalizeTokenHost)
        .filter((h) => h.length > 0)
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
        throttledRequestCount: 0,
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

    // Intercept requests to add the internal header only to same-origin
    // requests, avoiding CORS preflight failures on third-party domains.
    await page.setRequestInterception(true);

    // Detect navigation loops (e.g., infinite redirect between routes)
    const ctx: RenderContext = {
      firstPartyReqPending: new Map(),
      outgoingRequests: new Set(),
      beaconSession: this._beaconDetector?.startRender() ?? null,
      readinessSignal: { domStableSince: null },
      navigationCount: 0,
    };
    this.attachNavigationGuard(page, ctx);
    this.attachRequestInterceptor(page, ctx);
    this.attachResponseHandlers(page, ctx, diagnostics);
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

    const ready = await this.waitForPageReady({
      page,
      firstPartyReqPending: ctx.firstPartyReqPending,
      readinessSignal: ctx.readinessSignal,
    });
    this._logger.debug(`[Prerender] Snapshot triggered by: ${ready.reason}`);
    if (!response) {
      throw new Error(`Failed to navigate to ${this._url}`);
    }

    if (ctx.outgoingRequests.size > 0) {
      this._logger.debug(
        "Unresolved requests:",
        JSON.stringify(
          Array.from(ctx.outgoingRequests).map((req) => req.url()),
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

    if (ctx.navigationCount > MAX_NAVIGATIONS) {
      throw new RenderFailureError(
        `Navigation loop detected for ${this._url}: ${ctx.navigationCount} navigations (final URL: ${page.url()})`,
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
        readyReason: ready.reason,
        readyDetail: ready.detail,
        durationMs: Date.now() - diagnostics.startedAt,
        throttledRequestCount: diagnostics.throttledRequestCount,
        failedRequests: diagnostics.failedRequests,
        pendingRequests: Array.from(ctx.firstPartyReqPending.keys(), (req) =>
          req.url(),
        ),
        consoleErrors: diagnostics.consoleErrors,
        pageErrors: diagnostics.pageErrors,
        beaconEndpoints: ready.suppressedBeaconKeys,
      },
    };
  }

  /** The customer's own hosts: the render target plus its routing domains. */
  private isCustomerHost(hostname: string): boolean {
    return (
      hostname === this._targetHost || this._internalKeyHosts.has(hostname)
    );
  }

  /** Abort the render if the page bounces between routes indefinitely. */
  private attachNavigationGuard(page: Page, ctx: RenderContext): void {
    page.on("framenavigated", (frame) => {
      this._logger.debug(`[FrameNavigated] ${frame.url()}`);
      if (
        getHostname(frame.url()) !== this._targetHost ||
        frame.parentFrame() !== null
      ) {
        return;
      }
      ctx.navigationCount++;
      if (ctx.navigationCount > MAX_NAVIGATIONS) {
        this._logger.debug(
          `[Prerender] Navigation loop detected (${ctx.navigationCount} navigations), aborting JS execution`,
        );
        void page.close().catch(() => void 0);
      }
    });
  }

  /**
   * Serves cached assets, stamps first-party auth headers, and tracks which
   * requests gate readiness. Must be attached before navigation so requests
   * issued during page.goto are captured.
   */
  private attachRequestInterceptor(page: Page, ctx: RenderContext): void {
    page.on("request", (req: HTTPRequest) => {
      let url: URL;
      try {
        url = new URL(req.url());
      } catch {
        return;
      }
      const resourceType = req.resourceType();

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

      const reqHost = normalizeTokenHost(url.hostname);
      const isCustomerHost = this.isCustomerHost(reqHost);
      const headers = req.headers();
      if (reqHost === this._targetHost) {
        headers[INTERNAL_PRERENDER_HEADER] = "1";
      }
      if (this._internalKey && isCustomerHost) {
        headers[ENCITED_INTERNAL_KEY_HEADER] = this._internalKey;
      } else {
        deleteHeader(headers, ENCITED_INTERNAL_KEY_HEADER);
      }
      const tokenForHost = renderTokenFor(
        url,
        this._renderTokenHosts,
        this._renderToken,
      );
      if (tokenForHost) {
        headers[RENDER_TOKEN_HEADER] = tokenForHost;
      } else {
        deleteHeader(headers, RENDER_TOKEN_HEADER);
      }
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
      req.continue({ headers }).catch(() => void 0);

      ctx.outgoingRequests.add(req);
      // Classified endpoints are suppressed inside waitForPageReady's idle
      // computation rather than here, so diagnostics keep the full pending
      // picture and a verdict from one pipeline applies to every concurrent
      // render at once. Hits are recorded on the response — only successful
      // completions count.
      const isDataRequest = resourceType === "fetch" || resourceType === "xhr";
      if (
        shouldTrackRequest({
          resourceType,
          host: reqHost,
          path: url.pathname,
          targetHost: this._targetHost,
        })
      ) {
        ctx.firstPartyReqPending.set(req, {
          startedAt: Date.now(),
          key:
            ctx.beaconSession && isDataRequest
              ? BeaconDetector.endpointKey(url)
              : null,
        });
      }
    });
  }

  /**
   * One dispatcher for every response concern: error/throttle diagnostics,
   * beacon hit recording, and the job-wide asset cache. Settle handlers live
   * here too, since they close the loop opened by the interceptor.
   */
  private attachResponseHandlers(
    page: Page,
    ctx: RenderContext,
    diagnostics: DiagnosticsCollector,
  ): void {
    page.on("response", (res: HTTPResponse) => {
      try {
        const req = res.request();
        const resourceType = req.resourceType();
        const status = res.status();
        const isDataRequest =
          resourceType === "xhr" || resourceType === "fetch";

        if (status >= 400 && !isIgnoredHost(getHostname(res.url()) ?? "")) {
          this._logger.debug(
            `[ResponseError] ${status} ${resourceType} ${res.url()}`,
          );
          if (status === 429 && isDataRequest) {
            this.countThrottledResponse(res.url(), diagnostics);
          }
        }

        // 4xx/5xx is the page failing to get its content — a retry loop, not
        // telemetry — so only successful data calls build a beacon verdict.
        if (ctx.beaconSession && isDataRequest && status < 400) {
          ctx.beaconSession.record(
            res.url(),
            Date.now(),
            ctx.readinessSignal.domStableSince,
          );
        }
      } catch {
        // ignore
      }
      if (this._assetCache) {
        this.maybeCacheAsset(res).catch(() => void 0);
      }
    });

    const settle = (req: HTTPRequest) => {
      if (ctx.outgoingRequests.has(req)) {
        this._logger.debug(
          `[Prerender] Request ${req.url()} settled for ${this._url}`,
        );
      }
      ctx.outgoingRequests.delete(req);
      ctx.firstPartyReqPending.delete(req);
    };
    page.on("requestfinished", settle);
    page.on("requestfailed", settle);
  }

  /**
   * A 429 on a data call is origin pressure, and feeds render-cap demotion —
   * unless it came from a third-party collector we classified as a beacon
   * (whose retry pattern is not the customer's origin struggling).
   */
  private countThrottledResponse(
    url: string,
    diagnostics: DiagnosticsCollector,
  ): void {
    const parsed = new URL(url);
    if (isIgnoredPath(parsed.pathname)) {
      return;
    }
    const isCustomerHost = this.isCustomerHost(
      normalizeTokenHost(parsed.hostname),
    );
    if (isCustomerHost || !this._beaconDetector?.isBeacon(parsed)) {
      diagnostics.throttledRequestCount++;
    }
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
    if (!CACHEABLE_ASSET_TYPES.has(req.resourceType())) {
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
    const host = normalizeTokenHost(getHostname(url) ?? "");
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


  // Readiness probes run against a page that may be busy or mid-navigation:
  // cap every evaluate at a short timeout and fall back instead of throwing.
  // The fallback is a factory so time-based fallbacks reflect resolve time.
  private async evaluateWithTimeout<T>(
    page: Page,
    fn: () => T,
    fallback: () => T,
    probe: string,
    timeoutMs = 1000,
  ): Promise<T> {
    try {
      return await Promise.race([
        page.evaluate(fn) as Promise<T>,
        new Promise<T>((resolve) =>
          setTimeout(() => {
            this.noteProbeTimeout(probe, timeoutMs);
            resolve(fallback());
          }, timeoutMs),
        ),
      ]);
    } catch {
      return fallback();
    }
  }

  /**
   * A probe timeout means the renderer stopped answering evaluate, so every
   * readiness signal below is a fallback, not an observation — "no metadata"
   * really means "couldn't look". Logged throttled: once a page wedges, every
   * probe of every tick times out.
   */
  private noteProbeTimeout(probe: string, timeoutMs: number): void {
    this._probeTimeouts++;
    const now = Date.now();
    if (
      this._probeTimeouts > 1 &&
      now - this._lastProbeTimeoutLogAt < PROBE_TIMEOUT_LOG_INTERVAL_MS
    ) {
      return;
    }
    this._lastProbeTimeoutLogAt = now;
    this._logger.debug(
      `[Prerender] Readiness probe "${probe}" timed out after ${timeoutMs}ms — renderer not answering evaluate (${this._probeTimeouts} probe timeouts so far); readiness signals are falling back`,
    );
  }

  private async checkAppFlag({
    page,
  }: {
    page: Page;
  }): Promise<{ defined: boolean; ready: boolean }> {
    return this.evaluateWithTimeout(
      page,
      () => {
        // @ts-expect-error - custom window properties
        const ready = window.prerenderReady as unknown;
        // @ts-expect-error - custom window properties
        const snapshot = window.htmlSnapshot as unknown;
        return {
          defined: ready !== undefined || snapshot !== undefined,
          ready: ready === true || snapshot === true,
        };
      },
      () => ({ defined: false, ready: false }),
      "app-flag",
    );
  }

  private async getLastDomChange({ page }: { page: Page }): Promise<number> {
    return this.evaluateWithTimeout(
      page,
      () => {
        // @ts-expect-error - custom window properties
        return (window.__lastDomChange ?? Date.now()) as number;
      },
      () => Date.now(),
      "last-dom-change",
    );
  }

  private async getHeartbeatTick({
    page,
  }: {
    page: Page;
  }): Promise<number | null> {
    return this.evaluateWithTimeout<number | null>(
      page,
      () => {
        // @ts-expect-error - custom window properties
        return (window.__heartbeatTick ?? null) as number | null;
      },
      () => null,
      "heartbeat",
    );
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
            // A prerender always has the network, so a service worker can only
            // cost us: it adds an install/activate race to every render, and a
            // "kill-switch" SW (claim() + clients.navigate() from its activate
            // handler) deadlocks the tab outright — after which every evaluate,
            // and page.content() with it, hangs until the render timeout.
            //
            // The API stays present and inert rather than removed: plenty of
            // apps call navigator.serviceWorker.register() unguarded, and a
            // missing property turns that into a TypeError during boot — a
            // silent blank render, worse than the timeout being fixed.
            const noop = () => void 0;
            const registration = {
              installing: null,
              waiting: null,
              active: null,
              scope: location.origin + "/",
              updateViaCache: "none",
              update: () => Promise.resolve(),
              unregister: () => Promise.resolve(true),
              addEventListener: noop,
              removeEventListener: noop,
            };
            const container = {
              controller: null,
              // Deliberately unfaithful: with nothing registered a real browser
              // leaves `ready` pending forever, so an app that awaits it before
              // mounting would hang — the exact failure being removed here.
              ready: Promise.resolve(registration),
              // Resolves with a plausible registration so
              // `.then((reg) => reg.addEventListener(...))` chains don't throw.
              register: () => Promise.resolve(registration),
              getRegistration: () => Promise.resolve(undefined),
              getRegistrations: () => Promise.resolve([]),
              startMessages: noop,
              addEventListener: noop,
              removeEventListener: noop,
            };
            Object.defineProperty(navigator, "serviceWorker", {
              configurable: true,
              get: () => container,
            });
          } catch {
            void 0;
          }

          try {
            // @ts-expect-error - custom window properties
            window.__TO_HTML = true;
            // @ts-expect-error - custom window properties
            window.__ENCITED__ = { visit: "render" };
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
    return this.evaluateWithTimeout(
      page,
      () => {
        return !!(
          document.querySelector("title")?.textContent ||
          document.querySelector('meta[data-rh="true"]') ||
          document.querySelector("meta[data-react-helmet]")
        );
      },
      () => false,
      "head-metadata",
    );
  }

  private async waitForPageReady({
    page,
    firstPartyReqPending,
    readinessSignal,
  }: {
    page: Page;
    firstPartyReqPending: Map<HTTPRequest, PendingRequestInfo>;
    // Published each tick so the response handler can tell whether a hit
    // landed on an already-stable DOM (see BeaconDetector).
    readinessSignal?: ReadinessSignal;
  }): Promise<ReadyOutcome> {
    const mult = this._stabilityMultiplier;
    const networkQuietMs = NETWORK_QUIET_MS * mult;
    const domStableMs = DOM_STABLE_MS * mult;
    const postReadySettleMs = POST_READY_SETTLE_MS * mult;
    const pendingMaxAgeMs = PENDING_MAX_AGE_MS * mult;

    const startedAt = Date.now();
    const state: ReadinessState = {
      appSignaled: false,
      flagDefined: false,
      networkIdleSince: null,
      domStableSince: null,
      heartbeatAtNetworkIdle: null,
    };
    const suppressedBeaconKeys = new Set<string>();

    return new Promise<ReadyOutcome>((resolve, reject) => {
      let settled = false;
      let pendingTimeout: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (pendingTimeout) {
          clearTimeout(pendingTimeout);
          pendingTimeout = null;
        }
      };
      const settleResolve = (reason: ReadyReason, detail?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve({
          reason,
          detail,
          suppressedBeaconKeys: Array.from(suppressedBeaconKeys),
        });
      };
      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      // Track when the underlying signal first fired so we can log it, but
      // metadata is the gate for actually resolving.
      let signal: ReadySignal | null = null;
      let signalFiredAt: number | null = null;

      const tick = async () => {
        if (settled) {
          return;
        }

        const now = Date.now();
        const elapsed = now - startedAt;

        // Hard timeout — snapshot regardless of metadata. A flag-defined page
        // that never signaled still captures here (a misconfigured flag must
        // not starve the page of snapshots forever), but under a distinct
        // reason so these captures stay identifiable in snapshot metadata.
        if (elapsed >= HARD_TIMEOUT_MS) {
          this._logger.debug(
            "[Prerender] Hard timeout reached, taking snapshot",
          );
          return settleResolve(
            state.flagDefined && !state.appSignaled
              ? "hard_timeout_not_ready"
              : "hard_timeout",
          );
        }

        // ── Check metadata (title) every tick ──
        // Metadata is a first-class readiness requirement, not a post-check.
        const hasMetadata = await this.hasHeadMetadata({ page });

        // Record the app's readiness signal, but don't trust it on its own.
        // The app can set prerenderReady before its own data fetch resolves
        // (the skeleton race), so we still wait for first-party requests to go
        // quiet below before treating the signal as ready.
        if (!state.appSignaled) {
          const flag = await this.checkAppFlag({ page });
          if (flag.defined && !state.flagDefined) {
            state.flagDefined = true;
            this._logger.debug(
              "[Prerender] App defined a readiness flag; heuristic capture disabled until it signals",
            );
          }
          if (flag.ready) {
            state.appSignaled = true;
            this._logger.debug(
              "[Prerender] App signaled ready via prerenderReady/htmlSnapshot",
            );
          }
        }

        // DOM stability is measured every tick, not just while waiting for a
        // signal: the beacon classifier reads the published epoch on every
        // response, and a frozen value would stamp hits taken during a
        // churning DOM as post-stable.
        const lastDomChange = await this.getLastDomChange({ page });
        const domIdleTime = now - lastDomChange;
        if (domIdleTime >= domStableMs) {
          if (state.domStableSince === null) {
            state.domStableSince = now;
          }
        } else {
          state.domStableSince = null;
        }
        if (readinessSignal) {
          readinessSignal.domStableSince = state.domStableSince;
        }

        if (signal === null) {
          const active = countActivePending({
            pending: firstPartyReqPending,
            now,
            readinessStartedAt: startedAt,
            maxAgeMs: pendingMaxAgeMs,
            isBeaconKey: (key) =>
              this._beaconDetector?.isBeaconKey(key) === true,
          });
          for (const key of active.suppressedBeaconKeys) {
            suppressedBeaconKeys.add(key);
          }
          if (active.count === 0) {
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

          const networkIdleDuration =
            state.networkIdleSince !== null ? now - state.networkIdleSince : 0;
          let networkStable = networkIdleDuration >= networkQuietMs;
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

          signal = evaluateReadySignal({
            elapsed,
            appSignaled: state.appSignaled,
            flagDefined: state.flagDefined,
            networkStable,
            domStable: state.domStableSince !== null,
            networkIdleMs: networkIdleDuration,
            domIdleMs: domIdleTime,
          });
          if (signal) {
            signalFiredAt = now;
            this._logger.debug(
              `[Prerender] Signal ${signal.reason}${signal.detail ? ` (${signal.detail})` : ""}`,
            );
          }
        }

        // ── Resolution logic ──
        // Both metadata AND an underlying signal must be satisfied.
        // Metadata alone isn't enough (page might still be loading).
        // Signal alone isn't enough (title may not have been injected yet).
        if (hasMetadata && signal) {
          // Wait a short settle period after both conditions are met so
          // remaining meta tags (description, og:*) finish injecting.
          if (domIdleTime >= postReadySettleMs) {
            this._logger.debug(`[Prerender] Page ready: ${signal.reason}`);
            return settleResolve(signal.reason, signal.detail);
          }
        }

        // Metadata present but no signal yet — keep waiting for signal.
        // Signal present but no metadata — keep polling for metadata.
        if (signal && !hasMetadata && signalFiredAt !== null) {
          // Log once when we start waiting for metadata
          if (now - signalFiredAt < POLL_INTERVAL_MS * 2) {
            this._logger.debug(
              `[Prerender] Signal ready (${signal.reason}) but head metadata missing, will keep polling until hard timeout`,
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
