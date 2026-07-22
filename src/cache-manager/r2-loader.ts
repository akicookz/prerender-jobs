import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AppLogger } from "../logger";
import { buildSnapshotObjectKey } from "./kv-key-utils";
import { CACHE_VERSION, KvRecord } from "./type";
import { PageSeoAnalysis } from "../seo-analyzer/type";
import {
  renderDiagnosticsToMetadata,
  type RenderDiagnostics,
} from "../render-engine";

export class R2Loader {
  private readonly _targetUrl: string;
  private readonly _html: string;
  private readonly _seoAnalysis: PageSeoAnalysis;
  private readonly _userAgent: string;
  private readonly _diagnostics: RenderDiagnostics | undefined;
  private readonly _logger: AppLogger;
  private readonly _r2CacheConfig: {
    cfAccountId: string;
    r2AccessKeyId: string;
    r2SecretAccessKey: string;
    r2BucketName: string;
    cacheTtl: number;
  };

  static register({
    targetUrl,
    html,
    seoAnalysis,
    userAgent,
    diagnostics,
    r2CacheConfig,
  }: {
    targetUrl: string;
    html: string;
    seoAnalysis: PageSeoAnalysis;
    userAgent: string;
    diagnostics?: RenderDiagnostics;
    r2CacheConfig: {
      cfAccountId: string;
      r2AccessKeyId: string;
      r2SecretAccessKey: string;
      r2BucketName: string;
      cacheTtl: number;
    };
  }): R2Loader {
    return new R2Loader(
      targetUrl,
      html,
      seoAnalysis,
      userAgent,
      diagnostics,
      r2CacheConfig,
    );
  }

  private constructor(
    targetUrl: string,
    html: string,
    seoAnalysis: PageSeoAnalysis,
    userAgent: string,
    diagnostics: RenderDiagnostics | undefined,
    r2CacheConfig: {
      cfAccountId: string;
      r2AccessKeyId: string;
      r2SecretAccessKey: string;
      r2BucketName: string;
      cacheTtl: number;
    },
  ) {
    this._targetUrl = targetUrl;
    this._html = html;
    this._seoAnalysis = seoAnalysis;
    this._userAgent = userAgent;
    this._diagnostics = diagnostics;
    this._r2CacheConfig = r2CacheConfig;
    this._logger = AppLogger.register({
      prefix: `r2-loader`,
    });
  }

  async uploadR2Object(): Promise<
    | {
        r2Synced: false;
      }
    | {
        r2Synced: true;
        kvRecord: KvRecord;
        objectKey: string;
      }
  > {
    try {
      new URL(this._targetUrl);
    } catch (e) {
      this._logger.error(
        `Invalid URL: ${e instanceof Error ? e.message : String(e)}`,
      );
      return {
        r2Synced: false,
      };
    }

    const digest = await this.sha256Hex(this._html);
    const objectKey = await this.buildObjectKey();
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
        r2Metadata: this.buildR2ObjectMetadata({ kvRecord }),
      });
    } catch (e) {
      this._logger.error("Failed to upload R2 object:", e);
      return {
        r2Synced: false,
      };
    }
    return {
      r2Synced: true,
      kvRecord,
      objectKey,
    };
  }

  private get r2Client(): S3Client {
    return new S3Client({
      region: "auto",
      endpoint: `https://${this._r2CacheConfig.cfAccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this._r2CacheConfig.r2AccessKeyId,
        secretAccessKey: this._r2CacheConfig.r2SecretAccessKey,
      },
    });
  }

  private async putR2Object({
    objectKey,
    bodyBytes,
    r2Metadata,
  }: {
    objectKey: string;
    bodyBytes: Uint8Array;
    r2Metadata: Record<string, string>;
  }) {
    const { cacheTtl } = this._r2CacheConfig;
    await this.r2Client.send(
      new PutObjectCommand({
        Bucket: this._r2CacheConfig.r2BucketName,
        Key: objectKey,
        Body: bodyBytes,
        ContentType: "text/html; charset=utf-8",
        CacheControl: `public, max-age=${cacheTtl}, s-maxage=${cacheTtl}`,
        Metadata: r2Metadata,
      }),
    );
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
      createdAt: new Date().toISOString(),
      contentType: "text/html; charset=utf-8",
      contentLength,
      cacheVersion: CACHE_VERSION,
      userAgent: this._userAgent,
      accept: null,
    };
  }

  private buildR2ObjectMetadata({ kvRecord }: { kvRecord: KvRecord }) {
    return {
      url: kvRecord.url,
      digest: kvRecord.digest,
      createdAt: kvRecord.createdAt,
      cacheVersion: kvRecord.cacheVersion,
      userAgent: kvRecord.userAgent || "",
      accept: kvRecord.accept || "",
      // SEO analysis metrics
      seoStatusCode: String(this._seoAnalysis.statusCode),
      seoIndexable: String(this._seoAnalysis.indexable),
      seoSoft404Status: this._seoAnalysis.isSoft404
        ? String(this._seoAnalysis.soft404StatusCode ?? 404)
        : "",
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
      // Render-time diagnostics (ready reason, failed requests, console
      // errors, timing) for debugging snapshots from the dashboard.
      ...(this._diagnostics
        ? renderDiagnosticsToMetadata(this._diagnostics)
        : {}),
    };
  }

  /**
   * Deterministic per page: derived from the KV key (the page identity this
   * job and the worker agree on), so every re-render overwrites the same
   * object instead of accumulating timestamped copies. The lovablehtml
   * worker's buildObjectKey mirrors this derivation — keep in sync. The host
   * is normalized like buildKvKey's domain segment so www-preferred domains
   * land on the same key the worker derives.
   */
  private async buildObjectKey(): Promise<string> {
    return buildSnapshotObjectKey({ targetUrl: this._targetUrl });
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
