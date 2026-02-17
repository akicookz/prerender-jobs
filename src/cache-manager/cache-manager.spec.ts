import { describe, it, expect, vi, beforeEach } from "vitest";
import { CacheManager } from "./index";
import type { CacheConfig } from "./type";
import type { PageSeoAnalysis } from "../seo-analyzer/type";

// ---------------------------------------------------------------------------
// Hoisted mock functions – must be created before vi.mock() factories run
// ---------------------------------------------------------------------------

const { mockS3Send, mockKvGet, mockKvUpdate } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockKvGet: vi.fn(),
  mockKvUpdate: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  // Must use regular functions – arrow functions cannot be called with `new`
  S3Client: vi.fn(function () {
    return { send: mockS3Send };
  }),
  // Return the raw input so mock.calls[n][0] gives us the command params directly
  PutObjectCommand: vi.fn(function (input: unknown) {
    return input;
  }),
  DeleteObjectCommand: vi.fn(function (input: unknown) {
    return input;
  }),
}));

vi.mock("cloudflare", () => ({
  default: vi.fn(function () {
    return {
      kv: {
        namespaces: {
          values: { get: mockKvGet, update: mockKvUpdate },
        },
      },
    };
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CACHE_CONFIG: CacheConfig = {
  cacheTtl: 3600,
  cfAccountId: "cf-account-123",
  cfApiToken: "cf-token-abc",
  r2AccessKeyId: "r2-key-id",
  r2SecretAccessKey: "r2-secret",
  r2BucketName: "my-bucket",
  kvNamespaceId: "kv-ns-id",
};

const SEO_ANALYSIS: PageSeoAnalysis = {
  statusCode: 200,
  indexable: true,
  isSoft404: false,
  h1Count: 1,
  wordCount: 500,
  hasOgTags: true,
  hasTwitterTags: false,
  hasViewport: true,
  titleStatus: "ok",
  metaDescStatus: "ok",
  h1Status: "ok",
  contentStatus: "thin",
};

function makeManager(
  overrides: Partial<{
    targetUrl: string;
    html: string;
    seoAnalysis: PageSeoAnalysis;
    userAgent: string;
    cacheConfig: CacheConfig;
  }> = {},
) {
  return CacheManager.register({
    targetUrl: overrides.targetUrl ?? "https://example.com/page",
    html: overrides.html ?? "<html><body>Hello</body></html>",
    seoAnalysis: overrides.seoAnalysis ?? SEO_ANALYSIS,
    userAgent: overrides.userAgent ?? "test-bot/1.0",
    cacheConfig: overrides.cacheConfig ?? CACHE_CONFIG,
  });
}

/** Builds a fake Cloudflare KV values.get() response */
function kvGetResponse(status: number, body: string) {
  return {
    status,
    blob: () => ({ text: () => body }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("uploadCache() – return values", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockS3Send.mockResolvedValue({});
    mockKvGet.mockResolvedValue(kvGetResponse(404, ""));
    mockKvUpdate.mockResolvedValue({});
  });

  it("returns {kvSynced:false, r2Synced:false} for an invalid URL", async () => {
    const result = await makeManager({ targetUrl: "not-a-url" }).uploadCache();
    expect(result).toEqual({ kvSynced: false, r2Synced: false });
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it("returns {kvSynced:false, r2Synced:false} when R2 upload throws", async () => {
    mockS3Send.mockRejectedValueOnce(new Error("R2 network error"));
    const result = await makeManager().uploadCache();
    expect(result).toEqual({ kvSynced: false, r2Synced: false });
    expect(mockKvUpdate).not.toHaveBeenCalled();
  });

  it("returns {kvSynced:true, r2Synced:true} on full success", async () => {
    const result = await makeManager().uploadCache();
    expect(result).toEqual({ kvSynced: true, r2Synced: true });
  });

  it("returns {kvSynced:false, r2Synced:true} when KV update throws", async () => {
    mockKvUpdate.mockRejectedValueOnce(new Error("KV quota exceeded"));
    const result = await makeManager().uploadCache();
    expect(result).toEqual({ kvSynced: false, r2Synced: true });
  });
});

describe("uploadCache() – stale R2 invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockS3Send.mockResolvedValue({});
    mockKvUpdate.mockResolvedValue({});
  });

  it("does not issue a DeleteObject when there is no prior KV record (status 404)", async () => {
    mockKvGet.mockResolvedValue(kvGetResponse(404, ""));
    await makeManager().uploadCache();
    expect(mockS3Send).toHaveBeenCalledTimes(1); // PutObject only
  });

  it("issues DeleteObject for the stale key when existing KV record differs", async () => {
    const staleKey = "v1/example.com/old-page_deadbeef_stale.html";
    mockKvGet.mockResolvedValueOnce(
      kvGetResponse(
        200,
        JSON.stringify({
          url: "https://example.com/page",
          objectKey: staleKey,
          digest: "oldhash",
          createdAt: "2024-01-01T00:00:00.000Z",
          contentType: "text/html; charset=utf-8",
          contentLength: 100,
          cacheVersion: "v1",
          userAgent: "old-bot",
          accept: null,
        }),
      ),
    );

    await makeManager().uploadCache();

    expect(mockS3Send).toHaveBeenCalledTimes(2); // PutObject + DeleteObject
    const deleteArg = mockS3Send.mock.calls[1]?.[0] as {
      Key: string;
      Bucket: string;
    };
    expect(deleteArg.Key).toBe(staleKey);
    expect(deleteArg.Bucket).toBe(CACHE_CONFIG.r2BucketName);
  });

  it("continues to KV update and returns success even when invalidation throws", async () => {
    mockKvGet.mockRejectedValueOnce(new Error("KV timeout"));
    const result = await makeManager().uploadCache();
    expect(result).toEqual({ kvSynced: true, r2Synced: true });
    expect(mockKvUpdate).toHaveBeenCalledTimes(1);
  });

  it("skips R2 deletion when existing KV record contains invalid JSON", async () => {
    mockKvGet.mockResolvedValueOnce(kvGetResponse(200, "{ not valid json {{"));
    const result = await makeManager().uploadCache();
    expect(result).toEqual({ kvSynced: true, r2Synced: true });
    expect(mockS3Send).toHaveBeenCalledTimes(1); // PutObject only, no DeleteObject
  });
});

describe("uploadCache() – KV record content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockS3Send.mockResolvedValue({});
    mockKvGet.mockResolvedValue(kvGetResponse(404, ""));
    mockKvUpdate.mockResolvedValue({});
  });

  it("writes a KV record with correct URL and cache version", async () => {
    await makeManager().uploadCache();
    const [, , updateOpts] = mockKvUpdate.mock.calls[0] as [
      string,
      string,
      { value: string; expiration_ttl: number; account_id: string },
    ];
    const kvRecord = JSON.parse(updateOpts.value) as {
      url: string;
      cacheVersion: string;
      contentType: string;
    };
    expect(kvRecord.url).toBe("https://example.com/page");
    expect(kvRecord.cacheVersion).toBe("v1");
    expect(kvRecord.contentType).toBe("text/html; charset=utf-8");
  });

  it("uses cacheTtl from config as the KV expiration_ttl", async () => {
    await makeManager().uploadCache();
    const [, , updateOpts] = mockKvUpdate.mock.calls[0] as [
      string,
      string,
      { expiration_ttl: number },
    ];
    expect(updateOpts.expiration_ttl).toBe(CACHE_CONFIG.cacheTtl);
  });

  it("passes the correct namespace ID and account ID to KV update", async () => {
    await makeManager().uploadCache();
    const [namespaceId, , updateOpts] = mockKvUpdate.mock.calls[0] as [
      string,
      string,
      { account_id: string },
    ];
    expect(namespaceId).toBe(CACHE_CONFIG.kvNamespaceId);
    expect(updateOpts.account_id).toBe(CACHE_CONFIG.cfAccountId);
  });

  it("records the userAgent from the constructor in the KV record", async () => {
    await makeManager({ userAgent: "my-custom-bot" }).uploadCache();
    const [, , updateOpts] = mockKvUpdate.mock.calls[0] as [
      string,
      string,
      { value: string },
    ];
    const kvRecord = JSON.parse(updateOpts.value) as {
      userAgent: string;
    };
    expect(kvRecord.userAgent).toBe("my-custom-bot");
  });
});

describe("uploadCache() – KV key format", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockS3Send.mockResolvedValue({});
    mockKvGet.mockResolvedValue(kvGetResponse(404, ""));
    mockKvUpdate.mockResolvedValue({});
  });

  it("KV key starts with 'to_html:v1:'", async () => {
    await makeManager().uploadCache();
    const [, kvKey] = mockKvUpdate.mock.calls[0] as [string, string];
    expect(kvKey).toMatch(/^to_html:v1:/);
  });

  it("KV key includes the URL path", async () => {
    await makeManager({
      targetUrl: "https://example.com/some/path",
    }).uploadCache();
    const [, kvKey] = mockKvUpdate.mock.calls[0] as [string, string];
    expect(kvKey).toContain("/some/path");
  });

  it("strips internal prerender params (to_html, cache_invalidate) from KV key", async () => {
    await makeManager({
      targetUrl:
        "https://example.com/page?to_html=1&cache_invalidate=1&q=hello",
    }).uploadCache();
    const [, kvKey] = mockKvUpdate.mock.calls[0] as [string, string];
    expect(kvKey).toContain("q=hello");
    // Key prefix is "to_html:v1:…" – check the *query param* form is stripped
    expect(kvKey).not.toMatch(/[?&]to_html=/);
    expect(kvKey).not.toContain("cache_invalidate=");
  });

  it("produces the same KV key for two identical URLs", async () => {
    await makeManager({ targetUrl: "https://example.com/page" }).uploadCache();
    const [, firstKey] = mockKvUpdate.mock.calls[0] as [string, string];

    vi.clearAllMocks();
    mockS3Send.mockResolvedValue({});
    mockKvGet.mockResolvedValue(kvGetResponse(404, ""));
    mockKvUpdate.mockResolvedValue({});

    await makeManager({ targetUrl: "https://example.com/page" }).uploadCache();
    const [, secondKey] = mockKvUpdate.mock.calls[0] as [string, string];

    expect(firstKey).toBe(secondKey);
  });
});

describe("uploadCache() – R2 object params", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockS3Send.mockResolvedValue({});
    mockKvGet.mockResolvedValue(kvGetResponse(404, ""));
    mockKvUpdate.mockResolvedValue({});
  });

  it("uploads to the correct R2 bucket", async () => {
    await makeManager().uploadCache();
    const putArg = mockS3Send.mock.calls[0]?.[0] as { Bucket: string };
    expect(putArg.Bucket).toBe(CACHE_CONFIG.r2BucketName);
  });

  it("sets ContentType to text/html; charset=utf-8", async () => {
    await makeManager().uploadCache();
    const putArg = mockS3Send.mock.calls[0]?.[0] as { ContentType: string };
    expect(putArg.ContentType).toBe("text/html; charset=utf-8");
  });

  it("sets CacheControl using cacheTtl from config", async () => {
    await makeManager().uploadCache();
    const putArg = mockS3Send.mock.calls[0]?.[0] as { CacheControl: string };
    expect(putArg.CacheControl).toBe("public, max-age=3600, s-maxage=3600");
  });

  it("includes SEO analysis fields in R2 object metadata", async () => {
    await makeManager().uploadCache();
    const putArg = mockS3Send.mock.calls[0]?.[0] as {
      Metadata: Record<string, string>;
    };
    expect(putArg.Metadata).toMatchObject({
      seoStatusCode: "200",
      seoIndexable: "true",
      seoIsSoft404: "false",
      seoWordCount: "500",
      seoHasOgTags: "true",
      seoHasTwitterTags: "false",
      seoHasViewport: "true",
    });
  });

  it("stores the HTML as a Uint8Array body that decodes back to the original", async () => {
    const html = "<html><body>Test content</body></html>";
    await makeManager({ html }).uploadCache();
    const putArg = mockS3Send.mock.calls[0]?.[0] as { Body: Uint8Array };
    expect(putArg.Body).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(putArg.Body)).toBe(html);
  });

  it("R2 object key is scoped under the correct host directory", async () => {
    await makeManager({ targetUrl: "https://example.com/page" }).uploadCache();
    const putArg = mockS3Send.mock.calls[0]?.[0] as { Key: string };
    expect(putArg.Key).toMatch(/^v1\/example\.com\//);
  });
});
