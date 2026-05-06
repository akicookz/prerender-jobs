import { Browser, ConsoleMessage, HTTPRequest, Page } from "puppeteer-core";
import { getHostname } from "tldts";
import { AppLogger } from "./logger";
import { RenderTracer } from "./render-tracer";

const DEFAULT_RENDER_TIMEOUT = 55_000; // 55 seconds
const INTERNAL_PRERENDER_HEADER = "x-lovablehtml-internal";
const MAX_NAVIGATIONS = 10;
const MAX_RENDER_ATTEMPTS = 2;

export interface RenderResult {
  url: string;
  html: string;
  statusCode: number;
  xRobotsTag?: string | null;
  finalUrl: string;
}

type ReadinessState = {
  appSignaled: boolean;
  networkIdleSince: number | null;
  domStableSince: number | null;
};

export class RenderEngine {
  private readonly _url: string;
  private readonly _browser: Browser;
  private readonly _userAgent: string;
  private readonly _logger: AppLogger;

  static register({
    targetUrl,
    browser,
    userAgent,
  }: {
    targetUrl: string;
    browser: Browser;
    userAgent: string;
  }) {
    return new RenderEngine(targetUrl, browser, userAgent);
  }

  private constructor(targetUrl: string, browser: Browser, userAgent: string) {
    this._url = targetUrl;
    this._browser = browser;
    this._userAgent = userAgent.trim();
    this._logger = AppLogger.register({ prefix: "render-engine" });
  }

  async renderPage(): Promise<RenderResult> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RENDER_ATTEMPTS; attempt++) {
      const context = await this._browser.createBrowserContext();
      const page = await context.newPage();

      this.attachDebugListeners(page);

      try {
        return await Promise.race([
          this.renderPageInternal(page),
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

  private attachDebugListeners(page: Page): void {
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
            this._logger.debug(`[PageError] ${err?.message || err}`);
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

  private async renderPageInternal(page: Page): Promise<RenderResult> {
    const tracer = RenderTracer.enabled()
      ? RenderTracer.register({ url: this._url, page, logger: this._logger })
      : null;
    if (tracer) {
      await tracer.start();
    }

    try {
      return await this.renderPageInternalTraced(page, tracer);
    } finally {
      if (tracer) {
        await tracer.stop().catch(() => void 0);
      }
    }
  }

  private async renderPageInternalTraced(
    page: Page,
    tracer: RenderTracer | null,
  ): Promise<RenderResult> {
    await page.setViewport({ width: 1280, height: 720 });
    await page.setUserAgent({ userAgent: this._userAgent });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });
    await this.injectPrerenderScripts({ page });

    // Intercept requests to add the internal header only to same-origin requests,
    // avoiding CORS preflight failures on third-party domains.
    const targetHost = getHostname(this._url) ?? "";
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
      // Add the internal prerender header only to same-origin requests
      const reqHost = url.hostname;
      const headers = req.headers();
      if (reqHost === targetHost) {
        headers[INTERNAL_PRERENDER_HEADER] = "1";
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

    const navStartTimestamp = Date.now();
    this._logger.debug(`[Prerender] Navigating to ${this._url}`);
    let response;
    try {
      response = await page.goto(this._url, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
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

    await this.waitForPageReady({ page, firstPartyReqPending });
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

    // Don't cache server error pages — they're transient origin failures
    if (statusCode >= 500) {
      throw new Error(`Origin returned ${statusCode} for ${this._url}`);
    }

    if (navigationCount > MAX_NAVIGATIONS) {
      throw new Error(
        `Navigation loop detected for ${this._url}: ${navigationCount} navigations (final URL: ${page.url()})`,
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
    };
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
    const ignoredPaths = ["fb-conversions-api"];
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
    const NETWORK_QUIET_MS = 500;
    const DOM_STABLE_MS = 500;
    const POLL_INTERVAL_MS = 400;
    // After network+DOM are stable, wait an extra period for a final DOM
    // settle before taking the snapshot (covers late Helmet injections).
    const POST_READY_SETTLE_MS = 300;

    const startedAt = Date.now();
    const state: ReadinessState = {
      appSignaled: false,
      networkIdleSince: null,
      domStableSince: null,
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

        if (!signalReady) {
          // App signaled ready via prerenderReady/htmlSnapshot
          if (await this.checkAppSignal({ page })) {
            state.appSignaled = true;
            signalReady = true;
            signalReason = "app_signaled";
            signalFiredAt = now;
            this._logger.debug(
              "[Prerender] App signaled ready via prerenderReady/htmlSnapshot",
            );
          }
        }

        if (!signalReady) {
          if (firstPartyReqPending.size === 0) {
            if (state.networkIdleSince === null) {
              state.networkIdleSince = now;
            }
          } else {
            state.networkIdleSince = null;
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
          const networkStable = networkIdleDuration >= NETWORK_QUIET_MS;
          const domStable = state.domStableSince !== null;

          if (networkStable && domStable) {
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
