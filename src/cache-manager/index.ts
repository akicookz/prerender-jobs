import { AppLogger } from "../logger";
import normalizeUrl from "normalize-url";
import type { CacheConfig, KvRecord } from "./type";
import { DateTime } from "luxon";
import Cloudflare, { APIError } from "cloudflare";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { PageSeoAnalysis } from "../seo-analyzer/type";
import { Response } from "cloudflare/core";

export const INTERNAL_PRERENDER_PARAM = "to_html";
const CACHE_VERSION = "v1"; // bump to invalidate KV mapping semantics

export class CacheManager {
  private readonly _logger: AppLogger;

  private constructor(
    private readonly _targetUrl: string,
    private readonly _html: string,
    private readonly _seoAnalysis: PageSeoAnalysis,
    private readonly _userAgent: string,
    private readonly _cacheConfig: CacheConfig,
  ) {
    this._logger = AppLogger.register({
      prefix: `cache-manager:${this._targetUrl}`,
    });
  }

  static register({
    targetUrl,
    html,
    seoAnalysis,
    userAgent,
    cacheConfig,
  }: {
    targetUrl: string;
    html: string;
    seoAnalysis: PageSeoAnalysis;
    userAgent: string;
    cacheConfig: CacheConfig;
  }): CacheManager {
    return new CacheManager(
      targetUrl,
      html,
      seoAnalysis,
      userAgent,
      cacheConfig,
    );
  }

  async uploadCache(): Promise<{
    kvSynced: boolean;
    r2Synced: boolean;
  }> {
    let url: URL;
    try {
      url = new URL(this._targetUrl);
    } catch (e) {
      this._logger.error(
        `Invalid URL: ${e instanceof Error ? e.message : String(e)}`,
      );
      return {
        kvSynced: false,
        r2Synced: false,
      };
    }

    const digest = await this.sha256Hex(this._html);
    const objectKey = this.buildObjectKey({
      url,
      digest,
    });
    const bodyBytes = new TextEncoder().encode(this._html);
    const kvRecord = this.buildKvRecord({
      digest,
      objectKey,
      contentLength: bodyBytes.byteLength,
    });

    // Upload R2 object
    try {
      await this.putR2Object({
        objectKey,
        bodyBytes,
        kvRecord,
      });
    } catch (e) {
      this._logger.error(`Failed to upload R2 object: ${String(e)}`);
      return {
        kvSynced: false,
        r2Synced: false,
      };
    }

    // Update KV record
    const kvKey = this.buildKvKey({ url });

    // Invalidate stale R2 object
    try {
      await this.invalidateStaleR2Object({
        kvKey,
        objectKey,
      });
    } catch (e) {
      this._logger.error(`Failed to invalidate stale R2 object: ${String(e)}`);
    }

    try {
      await this.putKvRecord({
        kvKey,
        kvRecord,
      });
      return {
        kvSynced: true,
        r2Synced: true,
      };
    } catch (e) {
      this._logger.error(
        `Failed to update KV record: ${e instanceof Error ? e.message : String(e)}`,
      );
      return {
        kvSynced: false,
        r2Synced: true,
      };
    }
  }

  private get cfClient(): Cloudflare {
    return new Cloudflare({
      apiToken: this._cacheConfig.cfApiToken,
    });
  }

  private get r2Client(): S3Client {
    return new S3Client({
      region: "auto",
      endpoint: `https://${this._cacheConfig.cfAccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this._cacheConfig.r2AccessKeyId,
        secretAccessKey: this._cacheConfig.r2SecretAccessKey,
      },
    });
  }

  private async putR2Object({
    objectKey,
    bodyBytes,
    kvRecord,
  }: {
    objectKey: string;
    bodyBytes: Uint8Array;
    kvRecord: KvRecord;
  }) {
    const { cacheTtl } = this._cacheConfig;
    await this.r2Client.send(
      new PutObjectCommand({
        Bucket: this._cacheConfig.r2BucketName,
        Key: objectKey,
        Body: bodyBytes,
        ContentType: "text/html; charset=utf-8",
        CacheControl: `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}`,
        Metadata: this.buildR2ObjectMetadata({ kvRecord }),
      }),
    );
  }

  private buildR2ObjectMetadata({ kvRecord }: { kvRecord: KvRecord }) {
    return {
      url: this._targetUrl,
      digest: kvRecord.digest,
      createdAt: kvRecord.createdAt,
      cacheVersion: kvRecord.cacheVersion,
      userAgent: kvRecord.userAgent || "",
      accept: kvRecord.accept || "",
      // SEO analysis metrics
      seoStatusCode: String(this._seoAnalysis.statusCode),
      seoIndexable: String(this._seoAnalysis.indexable),
      seoIsSoft404: String(this._seoAnalysis.isSoft404),
      seoWordCount: String(this._seoAnalysis.wordCount),
      seoHasOgTags: String(this._seoAnalysis.hasOgTags),
      seoHasTwitterTags: String(this._seoAnalysis.hasTwitterTags),
      seoHasViewport: String(this._seoAnalysis.hasViewport),
      seoTitleStatus: this._seoAnalysis.titleStatus || "",
      seoMetaDescStatus: this._seoAnalysis.metaDescStatus || "",
      seoH1Status: this._seoAnalysis.h1Status || "",
      seoContentStatus: this._seoAnalysis.contentStatus || "",
      seoCanonicalMismatch: String(
        this._seoAnalysis.canonicalMismatch || false,
      ),
    };
  }

  private async invalidateStaleR2Object({
    kvKey,
    objectKey,
  }: {
    kvKey: string;
    objectKey: string;
  }) {
    const { cfAccountId, kvNamespaceId } = this._cacheConfig;
    let getKvRecordResponse: Response;
    try {
      getKvRecordResponse = await this.cfClient.kv.namespaces.values.get(
        kvNamespaceId,
        kvKey,
        { account_id: cfAccountId },
      );
    } catch (e) {
      if (e instanceof APIError && e.status === 404) {
        // No KV record found, skip stale object invalidation
        return;
      }
      throw e;
    }
    if (getKvRecordResponse.status !== 200) {
      return;
    }
    const kvRecordToReplaceBlob = await getKvRecordResponse.blob();
    const kvRecordToReplaceText = await kvRecordToReplaceBlob.text();
    let kvRecordToReplace: KvRecord;
    try {
      kvRecordToReplace = JSON.parse(kvRecordToReplaceText) as KvRecord;
    } catch {
      this._logger.error(
        `Failed to parse existing KV record: ${kvRecordToReplaceText}`,
      );
      return;
    }
    if (kvRecordToReplace.objectKey === objectKey) {
      return;
    }

    // Delete stale R2 object
    await this.r2Client.send(
      new DeleteObjectCommand({
        Bucket: this._cacheConfig.r2BucketName,
        Key: kvRecordToReplace.objectKey,
      }),
    );
  }

  private async putKvRecord({
    kvKey,
    kvRecord,
  }: {
    kvKey: string;
    kvRecord: KvRecord;
  }) {
    const { cfAccountId, kvNamespaceId, cacheTtl } = this._cacheConfig;
    await this.cfClient.kv.namespaces.values.update(kvNamespaceId, kvKey, {
      account_id: cfAccountId,
      value: JSON.stringify(kvRecord),
      expiration_ttl: cacheTtl,
    });
  }

  private buildKvRecord({
    digest,
    objectKey,
    contentLength,
  }: {
    digest: string;
    objectKey: string;
    contentLength: number;
  }): KvRecord {
    return {
      url: this._targetUrl,
      objectKey,
      digest,
      createdAt: DateTime.now().toISO(),
      contentType: "text/html; charset=utf-8",
      contentLength,
      cacheVersion: CACHE_VERSION,
      userAgent: this._userAgent,
      accept: null,
    };
  }

  private buildKvKey({ url }: { url: URL }): string {
    // Strip protocol and www, use only domain + path + query
    const hostname = url.hostname;
    const domain = normalizeUrl(hostname);
    const canonical = this.canonicalizePathForKey({ url });
    return `to_html:${CACHE_VERSION}:${domain}:${canonical}`;
  }

  private buildObjectKey({
    url,
    digest,
  }: {
    url: URL;
    digest: string;
  }): string {
    const safeHost = url.hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
    const safePath = url.pathname
      .replace(/^\//, "")
      .replace(/[^a-zA-Z0-9._/-]/g, "-")
      .replace(/\/+/, "/")
      .replace(/\//g, "_");
    const base = safePath || "root";
    const ts = DateTime.now().toISO().replace(/[:.]/g, "");
    return `${CACHE_VERSION}/${safeHost}/${base}_${digest.slice(
      0,
      16,
    )}_${ts}.html`;
  }

  private canonicalizePathForKey({ url }: { url: URL }): string {
    const params: Array<[string, string]> = [];
    const omit = new Set([
      INTERNAL_PRERENDER_PARAM,
      "cache_invalidate",
      "to_html",
      "x-lovablehtml-render",
    ]);
    for (const [k, v] of url.searchParams.entries()) {
      if (!omit.has(k)) params.push([k, v]);
    }
    params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    const qs = params.map(([k, v]) => `${k}=${v}`).join("&");
    return `${url.pathname}${qs ? `?${qs}` : ""}`;
  }

  private async sha256Hex(input: string): Promise<string> {
    const data = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      const h = bytes[i]!.toString(16).padStart(2, "0");
      hex += h;
    }
    return hex;
  }
}
