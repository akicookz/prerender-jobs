import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser, HTTPRequest, HTTPResponse, Page } from "puppeteer-core";
import {
  countActivePending,
  evaluateReadySignal,
  isDegradedRender,
  renderDiagnosticsToMetadata,
  RenderEngine,
  type ReadyOutcome,
} from "./render-engine";
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
): Promise<ReadyOutcome> {
  const fakePage = {
    evaluate: (fn: () => unknown) => Promise.resolve(fn()),
  } as unknown as Page;
  return (
    engine as unknown as {
      waitForPageReady(args: {
        page: Page;
        firstPartyReqPending: Map<HTTPRequest, PendingEntry>;
      }): Promise<ReadyOutcome>;
    }
  ).waitForPageReady({ page: fakePage, firstPartyReqPending });
}

/** The reason alone; most readiness tests only care about that. */
async function readyReason(promise: Promise<ReadyOutcome>): Promise<string> {
  return (await promise).reason;
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

    await expect(readyReason(ready)).resolves.toMatch(/network_and_dom_stable/);
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

    await expect(readyReason(ready)).resolves.toBe("app_signaled");
  });

  it("captures at hard timeout when prerenderReady stays false, with a distinct reason", async () => {
    installFakeDom({ prerenderReady: false });
    const ready = waitForPageReady(makeEngine());
    ready.catch(() => void 0);

    await vi.advanceTimersByTimeAsync(31_000);

    await expect(readyReason(ready)).resolves.toBe("hard_timeout_not_ready");
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

    await expect(readyReason(ready)).resolves.toMatch(/network_and_dom_stable/);
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

    await expect(readyReason(ready)).resolves.toBe("hard_timeout");
  });

  it("stops letting beacon-classified endpoints gate idle, across pipelines", async () => {
    installFakeDom({});
    const detector = BeaconDetector.register();
    // Another pipeline's render classifies the endpoint...
    const session = detector.startRender();
    const t0 = Date.now();
    session.record("https://example.com/OvxsBeacon?cb=1", t0, true);
    session.record("https://example.com/OvxsBeacon?cb=2", t0 + 3_000, true);
    session.record("https://example.com/OvxsBeacon?cb=3", t0 + 6_000, true);
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

    await expect(readyReason(ready)).resolves.toMatch(/network_and_dom_stable/);
    expect(pending.has(beaconReq)).toBe(true);
  });

  it("ages out redirect-orphaned subresources instead of gating forever", async () => {
    installFakeDom({});
    // A site that redirects to its custom domain abandons the pre-redirect
    // document's asset requests; they never settle. Measured on a real site:
    // nine orphaned .js stuck at 32s pinned the render to the hard timeout
    // when scripts were exempt from the cap.
    const orphanedScript = {
      url: () => "https://origin.lovable.app/assets/BlogPost-abc.js",
    } as unknown as HTTPRequest;
    const pending = new Map<HTTPRequest, PendingEntry>([
      [orphanedScript, { startedAt: Date.now(), key: null }],
    ]);
    const ready = waitForPageReady(makeEngine(), pending);
    ready.catch(() => void 0);

    await vi.advanceTimersByTimeAsync(15_000);

    await expect(readyReason(ready)).resolves.toMatch(/network_and_dom_stable/);
  });

  it("gives a request issued during a slow navigation its full grace period", async () => {
    installFakeDom({});
    // Issued 20s ago, mid page.goto; the readiness wait only starts now.
    // Aging from the request's own start would retire it on the first tick.
    const earlyXhr = {
      url: () => "https://example.com/api/bootstrap",
    } as unknown as HTTPRequest;
    const pending = new Map<HTTPRequest, PendingEntry>([
      [
        earlyXhr,
        { startedAt: Date.now() - 20_000, key: null },
      ],
    ]);
    const ready = waitForPageReady(makeEngine(), pending);
    let settled = false;
    void ready.then(() => (settled = true)).catch(() => void 0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(8_000);
    await expect(readyReason(ready)).resolves.toMatch(/network_and_dom_stable/);
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

    await expect(readyReason(ready)).resolves.toBe("hard_timeout");
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
    const ctx = {
      firstPartyReqPending: new Map(),
      outgoingRequests: new Set(),
      beaconSession: null,
      readinessSignal: { domStableSince: null },
      navigationCount: 0,
    };
    (
      engine as unknown as {
        attachResponseHandlers(
          page: Page,
          ctx: unknown,
          d: typeof diagnostics,
        ): void;
      }
    ).attachResponseHandlers(fakePage, ctx, diagnostics);
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
      session.record(url, at, true);
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
        readyReason: "network_and_dom_stable",
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


function pendingEntry(
  url: string,
  entry: Partial<PendingEntry> & { startedAt: number },
): [HTTPRequest, PendingEntry] {
  return [
    { url: () => url } as unknown as HTTPRequest,
    { key: null, ...entry },
  ];
}

describe("countActivePending", () => {
  const NOW = 1_000_000;
  const base = {
    now: NOW,
    readinessStartedAt: NOW - 20_000,
    maxAgeMs: 10_000,
    isBeaconKey: () => false,
  };

  it("counts requests younger than the age cap and retires the rest", () => {
    const pending = new Map([
      pendingEntry("https://x.test/fresh", { startedAt: NOW - 1_000 }),
      pendingEntry("https://x.test/hung", { startedAt: NOW - 30_000 }),
    ]);
    expect(countActivePending({ ...base, pending }).count).toBe(1);
  });

  it("skips beacon-classified endpoints and reports them", () => {
    const pending = new Map([
      pendingEntry("https://x.test/beacon", {
        startedAt: NOW,
        key: "x.test/beacon",
      }),
      pendingEntry("https://x.test/data", { startedAt: NOW }),
    ]);
    const result = countActivePending({
      ...base,
      pending,
      isBeaconKey: (key) => key === "x.test/beacon",
    });
    expect(result.count).toBe(1);
    expect(result.suppressedBeaconKeys).toEqual(["x.test/beacon"]);
  });

  it("ages from readiness start, so a slow navigation costs no grace period", () => {
    // Issued 15s ago but readiness only began 1s ago: still within the cap.
    const pending = new Map([
      pendingEntry("https://x.test/bootstrap", { startedAt: NOW - 15_000 }),
    ]);
    expect(
      countActivePending({ ...base, pending, readinessStartedAt: NOW - 1_000 })
        .count,
    ).toBe(1);
  });
});

describe("evaluateReadySignal", () => {
  const base = {
    elapsed: 10_000,
    appSignaled: false,
    flagDefined: false,
    networkStable: true,
    domStable: true,
    networkIdleMs: 800,
    domIdleMs: 600,
  };

  it("prefers the app signal once the network is quiet", () => {
    expect(evaluateReadySignal({ ...base, appSignaled: true })?.reason).toBe(
      "app_signaled",
    );
    expect(
      evaluateReadySignal({
        ...base,
        appSignaled: true,
        networkStable: false,
      }),
    ).toBeNull();
  });

  it("holds every heuristic capture while a defined flag has not flipped", () => {
    expect(evaluateReadySignal({ ...base, flagDefined: true })).toBeNull();
    expect(
      evaluateReadySignal({
        ...base,
        flagDefined: true,
        domStable: false,
        elapsed: 25_000,
      }),
    ).toBeNull();
  });

  it("captures on network+DOM stability, with the measurements attached", () => {
    const signal = evaluateReadySignal(base);
    expect(signal?.reason).toBe("network_and_dom_stable");
    expect(signal?.detail).toBe("network idle 800ms, DOM stable 600ms");
  });

  it("falls back to a DOM timeout only after the extended wait", () => {
    const unstableDom = { ...base, domStable: false };
    expect(evaluateReadySignal({ ...unstableDom, elapsed: 2_000 })).toBeNull();
    expect(
      evaluateReadySignal({ ...unstableDom, elapsed: 4_000 })?.reason,
    ).toBe("network_stable_dom_timeout");
  });

  it("keeps waiting while the network is busy", () => {
    expect(
      evaluateReadySignal({ ...base, networkStable: false, elapsed: 25_000 }),
    ).toBeNull();
  });
});

describe("renderDiagnosticsToMetadata", () => {
  const base = {
    readyReason: "network_and_dom_stable" as const,
    readyDetail: "network idle 800ms",
    durationMs: 4200,
    failedRequests: [],
    pendingRequests: [],
    consoleErrors: [],
    pageErrors: [],
    throttledRequestCount: 0,
    beaconEndpoints: [],
  };

  it("emits a count beside every list, and keeps R2's 8KB metadata budget", () => {
    const meta = renderDiagnosticsToMetadata({
      ...base,
      pendingRequests: Array.from({ length: 50 }, (_, i) => `https://x.test/${i}`),
      consoleErrors: Array.from({ length: 50 }, () => "e".repeat(300)),
      beaconEndpoints: ["x.test/collect"],
    });
    // Counts report the full list even when the stored array was trimmed.
    expect(meta.renderPendingRequestCount).toBe("50");
    expect(meta.renderConsoleErrorCount).toBe("50");
    const storedErrors = JSON.parse(
      meta.renderConsoleErrors ?? "[]",
    ) as string[];
    expect(storedErrors.length).toBeLessThan(50);
    expect(meta.renderBeaconEndpoints).toBe('["x.test/collect"]');
    const bytes = Object.entries(meta).reduce(
      (n, [k, v]) => n + k.length + v.length,
      0,
    );
    expect(bytes).toBeLessThan(8192);
  });

  it("escapes non-ASCII so values stay valid HTTP header text", () => {
    const meta = renderDiagnosticsToMetadata({
      ...base,
      consoleErrors: ["emoji 🎉 and curly ’quotes’"],
    });
    // The stored value is pure ASCII, and parses back to the original text.
    expect(meta.renderConsoleErrors).not.toMatch(/[^\x20-\x7E]/);
    expect(meta.renderConsoleErrors).toContain("\\ud83c");
    const decoded = JSON.parse(meta.renderConsoleErrors ?? "[]") as string[];
    expect(decoded[0]).toBe("emoji 🎉 and curly ’quotes’");
  });
});
