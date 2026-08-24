import { AppLogger } from "./logger";
import { normalizeTokenHost } from "./util";
import { isIgnoredHost } from "./ignored-endpoints";

/**
 * Behavioral classification of telemetry endpoints, replacing host-list
 * maintenance: the worst offenders are first-party (sGTM proxies on the
 * customer's own domain), which a host list structurally can't catch.
 *
 * The rule keys on the asymmetry that defines the harm — a beacon resets the
 * network-idle clock but never the DOM-stability clock, since its responses
 * change nothing. Within one render an endpoint must complete successfully
 * BEACON_MIN_HITS times over BEACON_MIN_SPAN_MS, BEACON_MIN_POST_STABLE_HITS
 * of them inside a SINGLE unbroken DOM-stable stretch. Callers must not
 * record 4xx/5xx (a 429-retry loop otherwise looks like repeat-fire), and a
 * data fetch mutates the DOM when it lands, which ends the stretch — so
 * neither retries nor query waterfalls can qualify, however many operations
 * share one endpoint (endpointKey drops the query, so every GraphQL/tRPC
 * call collapses to one key). Verdicts are shared job-wide; every render is
 * the same site.
 *
 * Only readiness gating is affected — requests still load normally — so a
 * false positive costs at most an early snapshot behind the DOM/metadata
 * gates, and a false negative costs what happens today: a hard timeout.
 */
export const BEACON_MIN_HITS = 3;
export const BEACON_MIN_SPAN_MS = 5_000;
/**
 * One post-stable hit is not enough: a lazy query can fire once into a
 * settled page and only then mutate it. Two hits in the same stretch means
 * the endpoint kept firing across a span of DOM stability it never
 * disturbed — a page's own data calls end the stretch when they land.
 */
export const BEACON_MIN_POST_STABLE_HITS = 2;
// Per-render memory bound. Overflow leaves further endpoints untracked for
// that render only — the next render starts fresh, so one path-explosive
// page can't starve classification for the whole job.
const MAX_TRACKED_ENDPOINTS_PER_RENDER = 500;

type RenderHitState = {
  firstAt: number;
  hits: number;
  /** Hits so far inside `epoch`; reset whenever a new stretch begins. */
  postStableHits: number;
  /** The DOM-stable stretch those hits belong to (its start timestamp). */
  epoch: number | null;
};

export type BeaconRecord = {
  key: string;
  /** The endpoint is (by now) a classified beacon. */
  classified: boolean;
  /** This hit crossed the threshold. */
  newlyClassified: boolean;
};

export class BeaconDetector {
  // Job-wide verdicts only — bounded by the number of real beacons a site
  // runs, not by its URL space.
  private readonly _classified = new Set<string>();
  private readonly _logger = AppLogger.register({ prefix: "beacon-detector" });

  static register(): BeaconDetector {
    return new BeaconDetector();
  }

  private constructor() {}

  /**
   * Endpoint identity for one request URL: normalized host + path with the
   * query stripped (collectors cache-bust via query params) and the trailing
   * slash collapsed. Null for unparseable URLs.
   */
  static endpointKey(url: string | URL): string | null {
    try {
      const u = typeof url === "string" ? new URL(url) : url;
      const host = normalizeTokenHost(u.hostname);
      if (!host) return null;
      let path = u.pathname;
      if (path.length > 1 && path.endsWith("/")) {
        path = path.slice(0, -1);
      }
      return `${host}${path}`;
    } catch {
      return null;
    }
  }

  /** Per-render hit tracking; create one per render attempt. */
  startRender(): BeaconRenderSession {
    return new BeaconRenderSession(this);
  }

  isBeaconKey(key: string): boolean {
    return this._classified.has(key);
  }

  isBeacon(url: string | URL): boolean {
    const key = BeaconDetector.endpointKey(url);
    return key !== null && this._classified.has(key);
  }

  /** Endpoints classified so far, for end-of-run reporting. */
  classifiedEndpoints(): string[] {
    return Array.from(this._classified);
  }

  /** @internal called by BeaconRenderSession when a key crosses the bar. */
  markClassified(
    key: string,
    hits: number,
    spanMs: number,
    postStableHits: number,
  ): void {
    this._classified.add(key);
    // endpointKey always embeds a path starting with "/".
    const host = key.slice(0, key.indexOf("/"));
    // The static-list marker drives the shrink-the-list loop: "miss" means
    // the hand-maintained list would not have caught this endpoint.
    this._logger.info(
      `[BeaconDetector] Classified beacon endpoint ${key} ` +
        `(${hits} hits over ${(spanMs / 1000).toFixed(1)}s in one render, ` +
        `${postStableHits} after DOM stable; ` +
        `static ignore list: ${isIgnoredHost(host) ? "hit" : "miss"})`,
    );
  }
}

export class BeaconRenderSession {
  private readonly _hits = new Map<string, RenderHitState>();
  private _overflowLogged = false;

  constructor(private readonly _detector: BeaconDetector) {}

  /**
   * Record one successfully completed xhr/fetch. Callers must filter to
   * xhr/fetch below 400 (see the class doc). `domStableSince` identifies the
   * current DOM-stable stretch (null while the DOM is changing, and before
   * the readiness loop starts, so boot traffic never counts).
   */
  record(
    url: string | URL,
    now: number,
    domStableSince: number | null,
  ): BeaconRecord | null {
    const key = BeaconDetector.endpointKey(url);
    if (!key) {
      return null;
    }
    if (this._detector.isBeaconKey(key)) {
      return { key, classified: true, newlyClassified: false };
    }
    let state = this._hits.get(key);
    if (!state) {
      if (this._hits.size >= MAX_TRACKED_ENDPOINTS_PER_RENDER) {
        if (!this._overflowLogged) {
          this._overflowLogged = true;
          AppLogger.register({ prefix: "beacon-detector" }).info(
            `[BeaconDetector] Render endpoint map full (${MAX_TRACKED_ENDPOINTS_PER_RENDER}); further unseen endpoints untracked this render`,
          );
        }
        return { key, classified: false, newlyClassified: false };
      }
      state = { firstAt: now, hits: 0, postStableHits: 0, epoch: null };
      this._hits.set(key, state);
    }
    state.hits++;
    if (domStableSince === null) {
      // The page is still changing; nothing to learn from this hit.
    } else if (domStableSince === state.epoch) {
      state.postStableHits++;
    } else {
      // A new stretch: the DOM moved since the last post-stable hit, so the
      // tally starts over rather than accumulating across the change.
      state.epoch = domStableSince;
      state.postStableHits = 1;
    }
    const span = now - state.firstAt;
    if (
      state.hits >= BEACON_MIN_HITS &&
      span >= BEACON_MIN_SPAN_MS &&
      state.postStableHits >= BEACON_MIN_POST_STABLE_HITS
    ) {
      this._detector.markClassified(key, state.hits, span, state.postStableHits);
      return { key, classified: true, newlyClassified: true };
    }
    return { key, classified: false, newlyClassified: false };
  }
}
