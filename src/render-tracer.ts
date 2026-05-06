import { CDPSession, HTTPRequest, Page } from "puppeteer-core";
import { AppLogger } from "./logger";

interface PendingRequest {
  url: string;
  resourceType: string;
  startedAt: number;
}

interface LifecycleEvent {
  name: string;
  frameId: string;
  loaderId: string;
  timestamp: number;
}

export class RenderTracer {
  private readonly _url: string;
  private readonly _page: Page;
  private readonly _logger: AppLogger;
  private readonly _startedAt: number;

  private _cdp: CDPSession | null = null;
  private readonly _pending = new Map<HTTPRequest, PendingRequest>();
  private _requestCount = 0;
  private _finishedCount = 0;
  private _failedCount = 0;
  private _stopped = false;

  static enabled(): boolean {
    return process.env.PRERENDER_TRACE?.toLowerCase() === "true";
  }

  static register({
    url,
    page,
    logger,
  }: {
    url: string;
    page: Page;
    logger: AppLogger;
  }): RenderTracer {
    return new RenderTracer(url, page, logger);
  }

  private constructor(url: string, page: Page, logger: AppLogger) {
    this._url = url;
    this._page = page;
    this._logger = logger;
    this._startedAt = Date.now();
  }

  async start(): Promise<void> {
    this.event("trace-start");

    try {
      this._cdp = await this._page.createCDPSession();
      await this._cdp.send("Page.enable");
      await this._cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
      this._cdp.on("Page.lifecycleEvent", (e: LifecycleEvent) => {
        if (this._stopped) return;
        this.event(
          `lifecycle:${e.name}`,
          `frame=${e.frameId.slice(0, 8)} loader=${e.loaderId.slice(0, 8)}`,
        );
      });
    } catch (e) {
      this.event(
        "trace-cdp-error",
        e instanceof Error ? e.message : String(e),
      );
    }

    this._page.on("request", (req) => this.onRequest(req));
    this._page.on("requestfinished", (req) => this.onRequestFinished(req));
    this._page.on("requestfailed", (req) => this.onRequestFailed(req));
  }

  private onRequest(req: HTTPRequest): void {
    if (this._stopped) return;
    this._requestCount++;
    this._pending.set(req, {
      url: req.url(),
      resourceType: String(req.resourceType()),
      startedAt: Date.now(),
    });
  }

  private onRequestFinished(req: HTTPRequest): void {
    if (this._stopped) return;
    this._finishedCount++;
    this._pending.delete(req);
  }

  private onRequestFailed(req: HTTPRequest): void {
    if (this._stopped) return;
    this._failedCount++;
    this._pending.delete(req);
  }

  async snapshot(reason: string): Promise<void> {
    this.event("snapshot", reason);

    // Document state — fetched via evaluate so we can correlate with what the
    // SPA thinks of itself. Capped at 1.5s in case the page is unresponsive.
    try {
      const state = await Promise.race([
        this._page.evaluate(() => ({
          readyState: document.readyState,
          title: (document.title ?? "").slice(0, 80),
          href: location.href,
          // @ts-expect-error - custom window properties
          prerenderReady: Boolean(window.prerenderReady),
          // @ts-expect-error - custom window properties
          htmlSnapshot: Boolean(window.htmlSnapshot),
          // @ts-expect-error - custom window properties
          lastDomChange: Number(window.__lastDomChange ?? 0),
          domNodeCount: document.querySelectorAll("*").length,
          headChildCount: document.head?.childElementCount ?? 0,
        })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
      if (state) {
        const domStaleMs =
          state.lastDomChange > 0 ? Date.now() - state.lastDomChange : -1;
        this.event(
          "doc-state",
          `readyState=${state.readyState} href=${state.href} title=${JSON.stringify(state.title)} headChildren=${state.headChildCount} nodes=${state.domNodeCount} domStaleMs=${domStaleMs} prerenderReady=${state.prerenderReady} htmlSnapshot=${state.htmlSnapshot}`,
        );
      } else {
        this.event(
          "doc-state",
          "evaluate timed out — page main thread is busy or unresponsive",
        );
      }
    } catch (e) {
      this.event(
        "doc-state-error",
        e instanceof Error ? e.message : String(e),
      );
    }

    // Per-page metrics — these come from Chromium's PerformanceMonitor.
    // ScriptDuration / TaskDuration tell us if V8 has been pinned (CPU
    // starvation) vs. just waiting on network.
    try {
      const m = await this._page.metrics();
      this.event(
        "page-metrics",
        `TaskDuration=${(m.TaskDuration ?? 0).toFixed(2)}s ScriptDuration=${(m.ScriptDuration ?? 0).toFixed(2)}s LayoutDuration=${(m.LayoutDuration ?? 0).toFixed(2)}s RecalcStyleDuration=${(m.RecalcStyleDuration ?? 0).toFixed(2)}s LayoutCount=${m.LayoutCount ?? 0} RecalcStyleCount=${m.RecalcStyleCount ?? 0} JSHeapUsedSize=${Math.round((m.JSHeapUsedSize ?? 0) / 1024 / 1024)}MB Nodes=${m.Nodes ?? 0} JSEventListeners=${m.JSEventListeners ?? 0} Frames=${m.Frames ?? 0} Documents=${m.Documents ?? 0}`,
      );
    } catch (e) {
      this.event(
        "page-metrics-error",
        e instanceof Error ? e.message : String(e),
      );
    }

    // Network summary — totals first, then a list of the longest-pending
    // requests so we can see what the page is actually waiting on.
    const now = Date.now();
    const pendingArr = Array.from(this._pending.values()).sort(
      (a, b) => a.startedAt - b.startedAt,
    );
    this.event(
      "network-summary",
      `total=${this._requestCount} finished=${this._finishedCount} failed=${this._failedCount} pending=${pendingArr.length}`,
    );
    for (const p of pendingArr.slice(0, 15)) {
      this.event(
        "pending-req",
        `ageMs=${now - p.startedAt} type=${p.resourceType} url=${p.url}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this._stopped) return;
    this._stopped = true;
    this.event("trace-stop");
    try {
      await this._cdp?.detach();
    } catch {
      // ignore — CDP session is auto-detached when the page closes
    }
    this._cdp = null;
  }

  private event(name: string, details?: string): void {
    const elapsed = Date.now() - this._startedAt;
    const tail = details ? ` ${details}` : "";
    this._logger.info(
      `[Trace] +${elapsed}ms ${name} url=${this._url}${tail}`,
    );
  }
}
