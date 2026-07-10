import { describe, expect, it } from "vitest";
import { AssetCache } from "./asset-cache";

const asset = (size: number, contentType = "application/javascript") => ({
  body: Buffer.alloc(size, "a"),
  contentType,
  corsHeaders: {},
});

describe("AssetCache", () => {
  it("returns null on a miss and the stored asset on a hit", () => {
    const cache = AssetCache.register();
    expect(cache.get("https://example.com/main.js")).toBeNull();

    cache.put("https://example.com/main.js", asset(100));
    const hit = cache.get("https://example.com/main.js");
    expect(hit?.body.length).toBe(100);
    expect(hit?.contentType).toBe("application/javascript");
  });

  it("keeps the first entry when the same URL is put twice", () => {
    const cache = AssetCache.register();
    cache.put("https://example.com/main.js", asset(100));
    cache.put("https://example.com/main.js", {
      body: Buffer.alloc(50, "b"),
      contentType: "text/css",
      corsHeaders: {},
    });

    const hit = cache.get("https://example.com/main.js");
    expect(hit?.body.length).toBe(100);
    expect(cache.stats().entryCount).toBe(1);
    expect(cache.stats().storedBytes).toBe(100);
  });

  it("rejects entries larger than the per-entry cap", () => {
    const cache = AssetCache.register({ maxEntryBytes: 10 });
    cache.put("https://example.com/huge.js", asset(11));

    expect(cache.get("https://example.com/huge.js")).toBeNull();
    expect(cache.stats().skippedEntries).toBe(1);
  });

  it("stops storing once the total byte cap is reached", () => {
    const cache = AssetCache.register({ maxTotalBytes: 150 });
    cache.put("https://example.com/a.js", asset(100));
    cache.put("https://example.com/b.js", asset(100));

    expect(cache.get("https://example.com/a.js")).not.toBeNull();
    expect(cache.get("https://example.com/b.js")).toBeNull();
    expect(cache.stats().entryCount).toBe(1);
    expect(cache.stats().skippedEntries).toBe(1);
  });

  it("tracks hits, misses, and served bytes", () => {
    const cache = AssetCache.register();
    cache.put("https://example.com/main.js", asset(100));

    cache.get("https://example.com/main.js");
    cache.get("https://example.com/main.js");
    cache.get("https://example.com/missing.js");
    cache.countMiss();

    const stats = cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.servedBytes).toBe(200);
  });
});
