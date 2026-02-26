import { Browser, ConsoleMessage, HTTPRequest, Page } from "puppeteer-core";
import { getHostname } from "tldts";
import { AppLogger } from "./logger";

const DEFAULT_RENDER_TIMEOUT = 30000; // 30 seconds
const INTERNAL_PRERENDER_HEADER = "x-lovablehtml-internal";
const INTERNAL_PRERENDER_PARAM = "to_html";

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
    const page = await this._browser.newPage();

    // Set up page event listeners for debugging (filtered to reduce noise)
    try {
      page.on("console", (msg: ConsoleMessage) => {
        try {
          const text = msg.text();
          // Skip noisy warnings about preload/crossorigin mismatches
          if (text.includes("preload") && text.includes("crossorigin")) return;
          // Only log errors, not warnings/info
          if (msg.type() === "error") {
            this._logger.debug("[PageConsole]", msg.type(), text);
          }
        } catch {
          // ignore
        }
      });
      page.on("pageerror", (err: unknown) => {
        if (err instanceof Error) {
          try {
            this._logger.debug("[PageError]", err?.message || err);
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

    try {
      await page.setUserAgent({ userAgent: this._userAgent });
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        [INTERNAL_PRERENDER_HEADER]: "1",
      });

      await this.injectPrerenderScripts({ page });

      const response = await page.goto(this._url, {
        waitUntil: "load",
        timeout: DEFAULT_RENDER_TIMEOUT,
      });
      await this.waitForPageReady({ page, url: this._url });
      if (!response) {
        throw new Error(`Failed to navigate to ${this._url}`);
      }

      const html = await page.content();
      const statusCode = response.status();
      const xRobotsTag = response.headers()["x-robots-tag"] ?? null;
      const finalUrl = page.url();

      return {
        url: this._url,
        html: this.reorderHeadTags(this.cleanInternalParamsFromHtml(html)),
        statusCode,
        xRobotsTag,
        finalUrl,
      };
    } catch (e) {
      this._logger.error(
        `Failed to render page ${this._url}: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    } finally {
      await page.close();
    }
  }

  private shouldTrackReq({
    req,
    targetHost,
  }: {
    req: HTTPRequest;
    targetHost: string;
  }): boolean {
    const trackResourceTypes = new Set([
      "document",
      "script",
      "xhr",
      "fetch",
      "stylesheet",
      "image",
      "font",
    ]);
    try {
      const host = getHostname(req.url());
      if (!host) {
        return false;
      }

      // Always ignore analytics/fonts/tracking
      if (this.isIgnoredHost(host)) {
        return false;
      }

      // For other resource types, only track first-party
      if (host !== targetHost) {
        return false;
      }

      const resourceType = req.resourceType() as unknown as string;
      return trackResourceTypes.has(resourceType);
    } catch {
      return false;
    }
  }

  private isIgnoredHost(host: string): boolean {
    // Domains to ignore for network idle detection (analytics, fonts, ads)
    const ignoredHosts = [
      "google-analytics.com",
      "googletagmanager.com",
      "fonts.googleapis.com",
      "fonts.gstatic.com",
      "www.googletagmanager.com",
      "analytics.google.com",
      "facebook.com",
      "connect.facebook.net",
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
    ];
    return ignoredHosts.some((h) => host === h || host.endsWith(`.${h}`));
  }

  private async checkAppSignal({ page }: { page: Page }): Promise<boolean> {
    try {
      return await page.evaluate(() => {
        // @ts-expect-error - custom window properties
        const ready = window.prerenderReady as boolean;
        // @ts-expect-error - custom window properties
        const snapshot = window.htmlSnapshot as boolean;
        return ready === true || snapshot === true;
      });
    } catch {
      return false;
    }
  }

  private async getLastDomChange({ page }: { page: Page }): Promise<number> {
    try {
      return await page.evaluate(() => {
        // @ts-expect-error - custom window properties
        return (window.__lastDomChange ?? Date.now()) as number;
      });
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

            const setupObserver = () => {
              if (!document.documentElement) {
                return;
              }
              const observer = new MutationObserver(() => {
                // @ts-expect-error - custom window properties
                window.__lastDomChange = Date.now();
              });
              observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
              });
            };

            if (document.documentElement) {
              setupObserver();
            } else {
              document.addEventListener("DOMContentLoaded", setupObserver);
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

  private async waitForPageReady({
    page,
    url,
  }: {
    page: Page;
    url: string;
  }): Promise<string> {
    // Track first-party requests for network idle detection
    const firstPartyReqPending = new Set<HTTPRequest>();

    const targetHost = getHostname(url) ?? "";

    page.on("request", (req: HTTPRequest) => {
      try {
        if (this.shouldTrackReq({ req, targetHost })) {
          firstPartyReqPending.add(req);
        }
      } catch {
        void 0;
      }
    });

    const settle = (req: HTTPRequest) => {
      try {
        firstPartyReqPending.delete(req);
      } catch {
        void 0;
      }
    };
    page.on("requestfinished", settle);
    page.on("requestfailed", settle);

    // Readiness detection constants
    const HARD_TIMEOUT_MS = 15000;
    const NETWORK_QUIET_MS = 500;
    const DOM_STABLE_MS = 300;
    const POLL_INTERVAL_MS = 100;

    const startedAt = Date.now();
    const state: ReadinessState = {
      appSignaled: false,
      networkIdleSince: null,
      domStableSince: null,
    };

    let pendingTimeout: NodeJS.Timeout | null = null;

    return new Promise<string>((resolve, reject) => {
      let settled = false;

      const settleResolve = (value: string) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      const tick = async () => {
        if (settled) {
          return;
        }

        const now = Date.now();
        const elapsed = now - startedAt;

        // Hard timeout reached, take snapshot
        if (elapsed >= HARD_TIMEOUT_MS) {
          this._logger.debug(
            "[Prerender] Hard timeout reached, taking snapshot",
          );
          this._logger.debug(
            "[Prerender] Hard timeout reached, taking snapshot",
          );
          return settleResolve("hard_timeout");
        }

        // App signaled ready via prerenderReady/htmlSnapshot
        if (await this.checkAppSignal({ page })) {
          this._logger.debug(
            "[Prerender] App signaled ready via prerenderReady/htmlSnapshot",
          );
          return settleResolve("app_signaled");
        }

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
          this._logger.debug(
            `[Prerender] Page ready: network idle for ${networkIdleDuration}ms, DOM stable for ${domIdleTime}ms`,
          );
          return settleResolve("network_and_dom_stable");
        }

        const MIN_WAIT_MS = 500;
        const DOM_EXTENDED_WAIT_MS = 3000;
        if (elapsed >= MIN_WAIT_MS && networkStable) {
          if (elapsed >= MIN_WAIT_MS + DOM_EXTENDED_WAIT_MS) {
            this._logger.debug(
              "[Prerender] Network stable, DOM still active but extended wait exceeded",
            );
            return settleResolve("network_stable_dom_timeout");
          }
        }

        pendingTimeout = setTimeout(
          () => void tick().catch((e: Error) => settleReject(e)),
          POLL_INTERVAL_MS,
        );
      };
      tick().catch((e: Error) => settleReject(e));
    }).finally(() => {
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
      }
    });
  }

  /**
   * Remove internal prerender parameters (to_html, cache_invalidate) from URLs
   * in SEO-critical meta tags (canonical, og:url, etc.) to prevent polluted URLs
   * from appearing in search results and social shares.
   */
  private cleanInternalParamsFromHtml(html: string): string {
    const paramsToRemove = [INTERNAL_PRERENDER_PARAM, "cache_invalidate"];

    // Helper to clean a URL string
    const cleanUrl = (urlStr: string): string => {
      try {
        const url = new URL(urlStr);
        let modified = false;
        for (const param of paramsToRemove) {
          if (url.searchParams.has(param)) {
            url.searchParams.delete(param);
            modified = true;
          }
        }
        return modified ? url.toString() : urlStr;
      } catch {
        // Not a valid URL, return as-is
        return urlStr;
      }
    };

    // Clean <link rel="canonical" href="...">
    html = html.replace(
      /<link\s+([^>]*rel=["']canonical["'][^>]*)>/gi,
      (match, attrs) => {
        if (typeof attrs !== "string") {
          return match;
        }
        const hrefMatch = attrs.match(/href=["']([^"']+)["']/i);
        if (hrefMatch && hrefMatch[1]) {
          const cleanedHref = cleanUrl(hrefMatch[1]);
          if (cleanedHref !== hrefMatch[1]) {
            return match.replace(hrefMatch[0], `href="${cleanedHref}"`);
          }
        }
        return match;
      },
    );

    // Clean <meta property="og:url" content="...">
    html = html.replace(
      /<meta\s+([^>]*property=["']og:url["'][^>]*)>/gi,
      (match, attrs) => {
        if (typeof attrs !== "string") {
          return match;
        }
        const contentMatch = attrs.match(/content=["']([^"']+)["']/i);
        if (contentMatch && contentMatch.length > 0) {
          const cleanedContent = cleanUrl(contentMatch[1]!);
          if (cleanedContent !== contentMatch[1]) {
            return match.replace(
              contentMatch[0],
              `content="${cleanedContent}"`,
            );
          }
        }
        return match;
      },
    );

    // Clean <meta name="twitter:url" content="..."> (some sites use this)
    html = html.replace(
      /<meta\s+([^>]*name=["']twitter:url["'][^>]*)>/gi,
      (match, attrs) => {
        if (typeof attrs !== "string") {
          return match;
        }
        const contentMatch = attrs.match(/content=["']([^"']+)["']/i);
        if (contentMatch && contentMatch.length > 0) {
          const cleanedContent = cleanUrl(contentMatch[1]!);
          if (cleanedContent !== contentMatch[1]) {
            return match.replace(
              contentMatch[0],
              `content="${cleanedContent}"`,
            );
          }
        }
        return match;
      },
    );

    return html;
  }

  /**
   * Reorder <head> tags so SEO-critical tags appear before scripts and styles.
   * Uses data-rh="true" attribute that react-helmet-async adds to its tags.
   * Also handles <title> which helmet may not mark with data-rh.
   */
  private reorderHeadTags(html: string): string {
    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    if (!headMatch) return html;

    const headContent = headMatch[1];
    const headStart = headMatch.index!;
    const fullHeadTag = headMatch[0];

    // Extract tags to hoist (in order of priority)
    const hoistPatterns: Array<{ pattern: RegExp; tags: string[] }> = [
      { pattern: /<meta\s+charset[^>]*>/gi, tags: [] },
      { pattern: /<meta\s+name="viewport"[^>]*>/gi, tags: [] },
      { pattern: /<title[^>]*>[\s\S]*?<\/title>/gi, tags: [] },
      {
        pattern: /<[^>]+data-rh="true"[^>]*>(?:[\s\S]*?<\/[^>]+>)?/gi,
        tags: [],
      },
    ];

    let remaining = headContent;

    // Extract each pattern's matches
    for (const item of hoistPatterns) {
      const matches = remaining?.match(item.pattern);
      if (matches) {
        item.tags.push(...matches);
        for (const match of matches) {
          remaining = remaining?.replace(match, "");
        }
      }
    }

    // Flatten hoisted tags in priority order
    const hoistedTags = hoistPatterns.flatMap((item) => item.tags);

    if (hoistedTags.length === 0) return html;

    // Clean up whitespace from removals
    remaining = remaining?.replace(/\n\s*\n\s*\n/g, "\n").trim();

    // Reconstruct head: hoisted tags first, then remaining content
    const newHeadContent =
      "\n    " +
      hoistedTags.join("\n    ") +
      (remaining ? "\n    " + remaining : "") +
      "\n  ";

    const newHead = `<head>${newHeadContent}</head>`;

    return (
      html.slice(0, headStart) +
      newHead +
      html.slice(headStart + fullHeadTag.length)
    );
  }
}
