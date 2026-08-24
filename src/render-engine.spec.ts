import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser, HTTPRequest, HTTPResponse, Page } from "puppeteer-core";
import { isDegradedRender, RenderEngine } from "./render-engine";
import { BeaconDetector } from "./beacon-detector";

type PendingEntry = { startedAt: number; key: string | null };

type FakeWindow = {
  prerenderReady?: boolean;
  htmlSnapshot?: boolean;
  __lastDomChange?: number;
  __heartbeatTick?: number;
};

// waitForPageReady's probes run through page.evaluate, whose callbacks
// reference the page's window/document globals. Running them in-process
// against these fakes exercises the real readiness loop without a browser.
function installFakeDom(win: FakeWindow): void {
  win.__lastDomChange ??= Date.now();
  const installedAt = Date.now();
  if (!("__heartbeatTick" in win)) {
    Object.defineProperty(win, "__heartbeatTick", {
      get: () => Math.floor((Date.now() - installedAt) / 100),
    });
  }
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).document = {
    querySelector: (selector: string) =>
      selector === "title" ? { textContent: "Title" } : null,
  };
}

function makeEngine(opts?: {
  beaconDetector?: BeaconDetector;
  extendedStability?: boolean;
}): RenderEngine {
  return RenderEngine.register({
    targetUrl: "https://example.com/page",
    browser: {} as Browser,
    userAgent: "test-agent",
    beaconDetector: opts?.beaconDetector,
    extendedStability: opts?.extendedStability,
  });
}

function waitForPageReady(
  engine: RenderEngine,
  firstPartyReqPending: Map<HTTPRequest, PendingEntry> = new Map(),
): Promise<string> {
  const fakePage = {
    evaluate: (fn: () => unknown) => Promise.resolve(fn()),
  } as unknown as Page;
  return (
    engine as unknown as {
      waitForPageReady(args: {
        page: Page;
        firstPartyReqPending: Map<HTTPRequest, PendingEntry>;
        suppressedBeaconKeys?: Set<string>;
      }): Promise<string>;
    }
  ).waitForPageReady({
    page: fakePage,
    firstPartyReqPending,
    suppressedBeaconKeys: new Set(),
  });
}

describe("waitForPageReady readiness-flag contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
  });

  it("resolves via stability heuristics when the app never defines a readiness flag", async () => {
    installFakeDom({});
    const ready = waitForPageReady(makeEngine());
    ready.catch(() => void 0);

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(ready).resolves.toMatch(/network_and_dom_stable/);
  });

  it("resolves app_signaled when prerenderReady flips true before the hard timeout", async () => {
    const win: FakeWindow = { prerenderReady: false };
    installFakeDom(win);
    const ready = waitForPageReady(makeEngine());
    ready.catch(() => void 0);

    setTimeout(() => {
      win.prerenderReady = true;
    }, 10_000);
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(ready).resolves.toBe("app_signaled");
  });

  it("captures at hard timeout when prerenderReady stays false, with a distinct reason", async () => {
    installFakeDom({ prerenderReady: false });
    const ready = waitForPageReady(makeEngine());
    ready.catch(() => void 0);

    await vi.advanceTimersByTimeAsync(31_000);

    await expect(ready).resolves.toBe("hard_timeout_not_ready");
  });

  it("stops letting a request gate idle once it pends past PENDING_MAX_AGE_MS", async () => {
    installFakeDom({});
    const hungRequest = {
      url: () => "https://ps.pndsn.com/v2/subscribe/x/y/0",
    } as unknown as HTTPRequest;
    // A long-poll that never settles: before the age cap this rode every
    // render to hard_timeout; now it stops gating at 10s and the render
    // resolves via the normal stability heuristics shortly after.
    const pending = new Map<HTTPRequest, PendingEntry>([
      [hungRequest, { startedAt: Date.now(), key: null }],
    ]);
    const ready = waitForPageReady(makeEngine(), pending);
    ready.catch(() => void 0);

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(ready).resolves.toMatch(/network_and_dom_stable/);
    // Still listed for the pendingRequests diagnostic.
    expect(pending.has(hungRequest)).toBe(true);
  });

  it("scales the age cap on the extended-stability retry (no 10s cliff)", async () => {
    installFakeDom({});
    const hungRequest = {
      url: () => "https://example.com/api/slow-data",
    } as unknown as HTTPRequest;
    const pending = new Map<HTTPRequest, PendingEntry>([
      [hungRequest, { startedAt: Date.now(), key: null }],
    ]);
    // At 4x the cap (40s) exceeds the hard timeout, so a still-pending data
    // request holds the retry render all the way to hard_timeout instead of
    // being aged out at 10s like on the first attempt.
    const ready = waitForPageReady(
      makeEngine({ extendedStability: true }),
      pending,
    );
    ready.catch(() => void 0);

    await vi.advanceTimersByTimeAsync(31_000);

    await expect(ready).resolves.toBe("hard_timeout");
  });

  it("stops letting beacon-classified endpoints gate idle, across pipelines", async () => {
    installFakeDom({});
    const detector = BeaconDetector.register();
    // Another pipeline's render classifies the endpoint...
    const session = detector.startRender();
    const t0 = Date.now();
    session.record("https://example.com/OvxsBeacon?cb=1", t0);
    session.record("https://example.com/OvxsBeacon?cb=2", t0 + 3_000);
    session.record("https://example.com/OvxsBeacon?cb=3", t0 + 6_000);
    expect(detector.isBeaconKey("example.com/OvxsBeacon")).toBe(true);
    // ...and this render's already-pending request to it stops gating
    // immediately (no sweep needed), while staying in the diagnostics map.
    const beaconReq = {
      url: () => "https://example.com/OvxsBeacon?cb=4",
    } as unknown as HTTPRequest;
    const pending = new Map<HTTPRequest, PendingEntry>([
      [beaconReq, { startedAt: Date.now(), key: "example.com/OvxsBeacon" }],
    ]);
    const ready = waitForPageReady(makeEngine({ beaconDetector: detector }), pending);
    ready.catch(() => void 0);

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(ready).resolves.toMatch(/network_and_dom_stable/);
    expect(pending.has(beaconReq)).toBe(true);
  });

  it("still hard-times-out while a fresh tracked request keeps the network busy", async () => {
    installFakeDom({});
    const pending = new Map<HTTPRequest, PendingEntry>();
    const ready = waitForPageReady(makeEngine(), pending);
    ready.catch(() => void 0);

    // A new data call starts every 5s — each entry is always younger than
    // the age cap, so the network never reads as idle.
    for (let t = 0; t < 30_000; t += 5_000) {
      pending.set(
        { url: () => `https://example.com/api/poll?${t}` } as unknown as HTTPRequest,
        { startedAt: Date.now() + t, key: null },
      );
    }
    await vi.advanceTimersByTimeAsync(31_000);

    await expect(ready).resolves.toBe("hard_timeout");
  });
});

function fakeResponse(
  status: number,
  resourceType: string,
  url: string,
): HTTPResponse {
  return {
    status: () => status,
    url: () => url,
    request: () => ({ resourceType: () => resourceType }),
  } as unknown as HTTPResponse;
}

describe("throttled-request diagnostics", () => {
  function countThrottled(
    responses: HTTPResponse[],
    engine: RenderEngine = makeEngine(),
  ): number {
    const handlers: Record<string, ((arg: never) => void)[]> = {};
    const fakePage = {
      on: (event: string, handler: (arg: never) => void) => {
        (handlers[event] ??= []).push(handler);
      },
    } as unknown as Page;
    const diagnostics = {
      startedAt: Date.now(),
      failedRequests: [],
      consoleErrors: [],
      pageErrors: [],
      throttledRequestCount: 0,
    };
    (
      engine as unknown as {
        attachDebugListeners(page: Page, d: typeof diagnostics): void;
      }
    ).attachDebugListeners(fakePage, diagnostics);
    for (const res of responses) {
      for (const h of handlers["response"] ?? []) h(res as never);
    }
    return diagnostics.throttledRequestCount;
  }

  it("counts 429s on xhr/fetch data calls", () => {
    const n = countThrottled([
      fakeResponse(429, "xhr", "https://base44.app/api/apps/x/entities/SiteConfig"),
      fakeResponse(429, "fetch", "https://example.com/api/data"),
    ]);
    expect(n).toBe(2);
  });

  it("ignores successes, non-data resource types, and ignored hosts", () => {
    const n = countThrottled([
      fakeResponse(200, "xhr", "https://base44.app/api/apps/x/entities/SiteConfig"),
      fakeResponse(429, "other", "https://example.com/favicon.ico"),
      fakeResponse(404, "image", "https://example.com/hero.png"),
      fakeResponse(429, "xhr", "https://api.mixpanel.com/track"),
    ]);
    expect(n).toBe(0);
  });

  it("suppresses 429s from classified third-party beacons but never from customer hosts", () => {
    const detector = BeaconDetector.register();
    const session = detector.startRender();
    const t0 = Date.now();
    for (const [url, at] of [
      ["https://collector.example.net/events", t0],
      ["https://collector.example.net/events", t0 + 3_000],
      ["https://collector.example.net/events", t0 + 6_000],
      // example.com is the engine's target host; classify an endpoint there
      // too (429-retry loops can look like repeat-fire).
      ["https://example.com/api/data", t0],
      ["https://example.com/api/data", t0 + 3_000],
      ["https://example.com/api/data", t0 + 6_000],
    ] as const) {
      session.record(url, at);
    }
    expect(detector.isBeacon("https://collector.example.net/events")).toBe(true);
    expect(detector.isBeacon("https://example.com/api/data")).toBe(true);

    const n = countThrottled(
      [
        fakeResponse(429, "xhr", "https://collector.example.net/events"),
        fakeResponse(429, "fetch", "https://example.com/api/data"),
      ],
      makeEngine({ beaconDetector: detector }),
    );
    // Third-party beacon 429 suppressed; customer-host 429 still counts as
    // origin pressure despite the classification.
    expect(n).toBe(1);
  });
});

describe("isDegradedRender", () => {
  it("flags hard-timeout captures and throttled renders, not clean ones", () => {
    expect(
      isDegradedRender({ readyReason: "app_signaled", throttledRequestCount: 0 }),
    ).toBe(false);
    expect(
      isDegradedRender({
        readyReason: "network_and_dom_stable (network idle 800ms, DOM stable 600ms)",
        throttledRequestCount: 0,
      }),
    ).toBe(false);
    expect(
      isDegradedRender({ readyReason: "hard_timeout", throttledRequestCount: 0 }),
    ).toBe(true);
    expect(
      isDegradedRender({
        readyReason: "hard_timeout_not_ready",
        throttledRequestCount: 0,
      }),
    ).toBe(true);
    expect(
      isDegradedRender({ readyReason: "app_signaled", throttledRequestCount: 3 }),
    ).toBe(true);
  });
});
