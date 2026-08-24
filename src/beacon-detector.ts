import { AppLogger } from "./logger";
import { normalizeTokenHost } from "./util";
import { isIgnoredHost } from "./ignored-endpoints";

/**
 * Behavioral classification of telemetry endpoints, replacing host-list
 * maintenance. The harm it targets: xhr/fetch beacons that keep firing reset
 * the render's network-idle clock forever and ride the render to its hard
 * timeout — and the worst offenders are FIRST-PARTY (server-side GTM proxies
 * with opaque paths on the customer's own domain), so a host list
 * structurally can't catch them.
 *
 * Classification is judged WITHIN a single render: an endpoint must fire
 * BEACON_MIN_HITS times spanning at least BEACON_MIN_SPAN_MS in one render.
 * A page's legitimate data fetches (GraphQL, Supabase REST) hit an endpoint
 * once or in a sub-second burst per page — they can never classify, no
 * matter how many renders a job runs. Repeat-fire inside one render is the
 * telemetry signature. Once classified, the verdict is shared job-wide
 * (every render is the same site), so later renders stop gating on the
 * endpoint from its first hit.
 *
 * Classification only affects readiness gating — the requests still load
 * normally — so a false positive costs at most a slightly-early snapshot
 * behind the DOM-stability/metadata gates, and a false negative costs what
 * happens today (a hard-timeout capture).
 */
export const BEACON_MIN_HITS = 3;
export const BEACON_MIN_SPAN_MS = 5_000;
// Per-render memory bound; a single page has far fewer distinct xhr/fetch
// endpoints. Once a render's map fills, unseen endpoints in that render are
// no longer tracked (which fails toward today's behavior); the next render
// starts with a fresh map, so one path-explosive page can't starve
// classification for the rest of the job.
const MAX_TRACKED_ENDPOINTS_PER_RENDER = 500;

type RenderHitState = {
  firstAt: number;
  hits: number;
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
  markClassified(key: string, hits: number, spanMs: number): void {
    this._classified.add(key);
    // endpointKey always embeds a path starting with "/".
    const host = key.slice(0, key.indexOf("/"));
    // The static-list marker drives the shrink-the-list loop: "miss" means
    // the hand-maintained list would not have caught this endpoint.
    this._logger.info(
      `[BeaconDetector] Classified beacon endpoint ${key} ` +
        `(${hits} hits over ${(spanMs / 1000).toFixed(1)}s in one render; ` +
        `static ignore list: ${isIgnoredHost(host) ? "hit" : "miss"})`,
    );
  }
}

export class BeaconRenderSession {
  private readonly _hits = new Map<string, RenderHitState>();
  private _overflowLogged = false;

  constructor(private readonly _detector: BeaconDetector) {}

  /**
   * Record one xhr/fetch request of this render. Callers should only pass
   * xhr/fetch — other resource types are either never readiness-gated
   * cross-site or are legitimate one-shot assets.
   */
  record(url: string | URL, now: number): BeaconRecord | null {
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
      state = { firstAt: now, hits: 0 };
      this._hits.set(key, state);
    }
    state.hits++;
    const span = now - state.firstAt;
    if (state.hits >= BEACON_MIN_HITS && span >= BEACON_MIN_SPAN_MS) {
      this._detector.markClassified(key, state.hits, span);
      return { key, classified: true, newlyClassified: true };
    }
    return { key, classified: false, newlyClassified: false };
  }
}
