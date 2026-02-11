import puppeteer, { Browser, HTTPRequest, Page } from "puppeteer-core";
import { getHostname } from "tldts";
import { logger } from "./logger.js";

const DEFAULT_RENDER_TIMEOUT = 30000; // 30 seconds
const INTERNAL_PRERENDER_HEADER = "x-lovablehtml-internal";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface SuccessfulRenderResult {
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
  private readonly _urls: string[];
  private browser: Browser | null = null;
  private readonly _userAgent: string;
  private readonly concurrency: number;

  static register({
    targetUrls,
    userAgent,
    concurrency,
  }: {
    targetUrls: string[];
    userAgent: string | undefined;
    concurrency: number;
  }) {
    return new RenderEngine(targetUrls, concurrency, userAgent);
  }

  private constructor(urls: string[], concurrency: number, userAgent?: string) {
    this._urls = urls;
    logger.info(`RenderEngine registered with ${this._urls.length} URLs`);
    this._urls.forEach((url, index) => {
      logger.info(`  - ${index + 1}: ${url}`);
    });
    this._userAgent = userAgent ? userAgent.trim() : DEFAULT_USER_AGENT;
    this.concurrency = concurrency;
  }

  async renderAll(): Promise<{
    successfulResults: SuccessfulRenderResult[];
    failedResults: { failReason: string }[];
  }> {
    try {
      this.browser = await puppeteer.launch({
        executablePath: "/usr/bin/chromium",
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      logger.info("Browser launched successfully");
    } catch (e) {
      logger.error(`Failed to launch browser: ${e}`);
      throw e;
    }
    if (!this.browser) {
      throw new Error("Browser not initialized");
    }
    try {
      logger.info(`Rendering ${this._urls.length} URLs`);
      const successfulResults: SuccessfulRenderResult[] = [];
      const failedResults: { failReason: string }[] = [];
      // batch render urls
      const batchSize = Math.ceil(this._urls.length / this.concurrency);
      for (let i = 0; i < this._urls.length; i += batchSize) {
        const batchUrls = this._urls.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(
          batchUrls.map((url) => this.renderPage({ url })),
        );
        batchResults.forEach((result, i) => {
          if (result.status === "fulfilled") {
            successfulResults.push(result.value);
            logger.info(`Successfully rendered ${batchUrls[i]}`);
          } else {
            failedResults.push({ failReason: result.reason });
            logger.error(`Failed to render ${batchUrls[i]}: ${result.reason}`);
          }
        });
      }
      return {
        successfulResults,
        failedResults,
      };
    } catch (e) {
      logger.error(`Failed to render URLs: ${e}`);
      throw e;
    } finally {
      await this.browser?.close();
    }
  }

  private async renderPage({
    url,
  }: {
    url: string;
  }): Promise<SuccessfulRenderResult> {
    if (!this.browser) {
      throw new Error("Browser not initialized");
    }
    const page = await this.browser.newPage();

    try {
      await page.setUserAgent({ userAgent: this._userAgent });
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        [INTERNAL_PRERENDER_HEADER]: "1",
      });

      await this.injectPrerenderScripts({ page });

      const response = await page.goto(url, {
        waitUntil: "load",
        timeout: DEFAULT_RENDER_TIMEOUT,
      });
      await this.waitForPageReady({ page, url });
      if (!response) {
        throw new Error(`Failed to navigate to ${url}`);
      }

      const html = await page.content();
      const statusCode = response.status();
      const xRobotsTag = response.headers()["x-robots-tag"] ?? null;
      const finalUrl = page.url();
      return { html, statusCode, xRobotsTag, finalUrl };
    } catch (e) {
      logger.error(`Failed to render page ${url}: ${e}`);
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
        const ready = window.prerenderReady;
        // @ts-expect-error - custom window properties
        const snapshot = window.htmlSnapshot;
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
        return window.__lastDomChange ?? Date.now();
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
      logger.debug("[Prerender] Error setting prerender init script", e);
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
      const settleReject = (error: unknown) => {
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
          logger.debug("[Prerender] Hard timeout reached, taking snapshot");
          return settleResolve("hard_timeout");
        }

        // App signaled ready via prerenderReady/htmlSnapshot
        if (await this.checkAppSignal({ page })) {
          logger.debug(
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
          logger.debug(
            `[Prerender] Page ready: network idle for ${networkIdleDuration}ms, DOM stable for ${domIdleTime}ms`,
          );
          return settleResolve("network_and_dom_stable");
        }

        const MIN_WAIT_MS = 500;
        const DOM_EXTENDED_WAIT_MS = 3000;
        if (elapsed >= MIN_WAIT_MS && networkStable) {
          if (elapsed >= MIN_WAIT_MS + DOM_EXTENDED_WAIT_MS) {
            logger.debug(
              "[Prerender] Network stable, DOM still active but extended wait exceeded",
            );
            return settleResolve("network_stable_dom_timeout");
          }
        }

        pendingTimeout = setTimeout(
          () => tick().catch((e) => settleReject(e)),
          POLL_INTERVAL_MS,
        );
      };
      tick().catch((e) => settleReject(e));
    }).finally(() => {
      if (pendingTimeout) {
        clearTimeout(pendingTimeout);
      }
    });
  }
}
