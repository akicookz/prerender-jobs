import { AppLogger } from "./logger";

// A job runs against a single customer site, so every stream re-downloads the
// same hashed JS/CSS/font bundles from the customer's origin on every render.
// This cache is shared across all streams and browsers for the lifetime of the
// job: each unique asset URL hits the origin once, and every later request is
// answered from memory via request interception (see RenderEngine).
//
// Only immutable-ish static assets belong here (script/stylesheet/font —
// enforced by the caller); documents and API responses must never be cached or
// snapshots would capture stale data.

// A job's asset set is one SPA's bundles — tens of MB at most. The caps guard
// against pathological sites (e.g. hundreds of MB of chunks) blowing the
// container's memory allocation, not against normal growth.
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 10 * 1024 * 1024;

export type CachedAsset = {
  body: Buffer;
  contentType: string;
  // Replayed on cache hits. Renders load the document from the render target
  // host while the page's absolute asset URLs point at the customer domain,
  // so fonts/module scripts are cross-origin — dropping the origin's
  // Access-Control-Allow-Origin header would make every replay fail CORS.
  corsHeaders: Record<string, string>;
};

export type AssetCacheStats = {
  entryCount: number;
  storedBytes: number;
  hits: number;
  servedBytes: number;
  skippedEntries: number;
};

export class AssetCache {
  private readonly _entries = new Map<string, CachedAsset>();
  private readonly _maxTotalBytes: number;
  private readonly _maxEntryBytes: number;
  private readonly _logger: AppLogger;
  private _storedBytes = 0;
  private _hits = 0;
  private _servedBytes = 0;
  private _skippedEntries = 0;
  private _capWarned = false;

  static register(options?: {
    maxTotalBytes?: number;
    maxEntryBytes?: number;
  }): AssetCache {
    return new AssetCache(
      options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      options?.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES,
    );
  }

  private constructor(maxTotalBytes: number, maxEntryBytes: number) {
    this._maxTotalBytes = maxTotalBytes;
    this._maxEntryBytes = maxEntryBytes;
    this._logger = AppLogger.register({ prefix: "asset-cache" });
  }

  get(url: string): CachedAsset | null {
    const entry = this._entries.get(url);
    if (!entry) {
      return null;
    }
    this._hits++;
    this._servedBytes += entry.body.length;
    return entry;
  }

  has(url: string): boolean {
    return this._entries.has(url);
  }

  put(url: string, asset: CachedAsset): void {
    if (this._entries.has(url)) {
      return;
    }
    if (asset.body.length > this._maxEntryBytes) {
      this._skippedEntries++;
      return;
    }
    if (this._storedBytes + asset.body.length > this._maxTotalBytes) {
      this._skippedEntries++;
      if (!this._capWarned) {
        this._capWarned = true;
        this._logger.warn(
          `[AssetCache] Byte cap reached (${this._maxTotalBytes} bytes stored); further assets will be fetched from origin`,
        );
      }
      return;
    }
    this._entries.set(url, asset);
    this._storedBytes += asset.body.length;
  }

  stats(): AssetCacheStats {
    return {
      entryCount: this._entries.size,
      storedBytes: this._storedBytes,
      hits: this._hits,
      servedBytes: this._servedBytes,
      skippedEntries: this._skippedEntries,
    };
  }
}
