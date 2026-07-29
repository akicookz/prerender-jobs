import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser, HTTPRequest, HTTPResponse, Page } from "puppeteer-core";
import { isDegradedRender, RenderEngine } from "./render-engine";

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

function makeEngine(): RenderEngine {
  return RenderEngine.register({
    targetUrl: "https://example.com/page",
    browser: {} as Browser,
    userAgent: "test-agent",
  });
}

function waitForPageReady(engine: RenderEngine): Promise<string> {
  const fakePage = {
    evaluate: (fn: () => unknown) => Promise.resolve(fn()),
  } as unknown as Page;
  return (
    engine as unknown as {
      waitForPageReady(args: {
        page: Page;
        firstPartyReqPending: Set<HTTPRequest>;
      }): Promise<string>;
    }
  ).waitForPageReady({
    page: fakePage,
    firstPartyReqPending: new Set<HTTPRequest>(),
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
  function countThrottled(responses: HTTPResponse[]): number {
    const engine = makeEngine();
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
