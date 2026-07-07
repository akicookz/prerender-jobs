import { uniq } from "es-toolkit";
import { backOff } from "exponential-backoff";
import { DateTime } from "luxon";
import * as TelegramBot from "node-telegram-bot-api";
import normalizeUrl from "normalize-url";
import puppeteer, { Browser } from "puppeteer-core";
import { buildKvKey, stripTrackingParams } from "./cache-manager/kv-key-utils";
import { KvLoader } from "./cache-manager/kv-loader";
import { R2Loader } from "./cache-manager/r2-loader";
import { KvRecord } from "./cache-manager/type";
import {
  sanitizeHtml,
  detectMetadataLoss,
  extractOversizedDataUrls,
  restoreDataUrls,
} from "./html-sanitizer";
import { loadConfig, type Configuration } from "./load-config";
import { AppLogger, INDENT } from "./logger";
import { RenderEngine, type RenderResult } from "./render-engine";
import { SeoAnalyzer } from "./seo-analyzer/index";
import type { PageSeoAnalysis } from "./seo-analyzer/type";
import { SitemapParser } from "./sitemap-parser";
import {
  escapeMarkdownV2,
  escapeMarkdownV2Code,
  extractPathFromUrl,
  sleep,
} from "./util";
import {
  countFailuresByReason,
  toFailureDetail,
  type PrerenderFailedPath,
  type PrerenderFailureDetail,
} from "./prerender-failure";

interface PipelineResult {
  url: string;
  cacheTtl: number;
  isRendered: boolean;
  isAnalyzed: boolean;
  isCachedToR2: boolean;
  isCachedToKv: boolean;
  /** Why the path failed — unset on success. */
  failure?: PrerenderFailureDetail;
  payloadForKv?: {
    kvRecord: KvRecord;
    objectKey: string;
  };
}

interface ReportResultBody {
  batch_id: string;
  user_id: string;
  source: string;
  google_cloud_execution_id: string;
  domain: string;
  canonical_domain: string;
  origin_host: string;
  urls_rendered: number;
  urls_synced_r2: number;
  urls_synced_kv: number;
  sitemap_url: string;
  sitemap_filter: string;
  started_at: string;
  finished_at: string;
  product_type: string;
  failed: {
    failed_to_render: {
      paths: PrerenderFailedPath[];
      count: number;
    };
    failed_to_sync: {
      paths: PrerenderFailedPath[];
      count: number;
    };
  };
  retry_options?: {
    parent_batch_group_ids: string[];
    parent_execution_ids: string[];
    retry_count: number;
  };
}

const logger = AppLogger.register({ prefix: "index" });

function getConfig(): Configuration {
  try {
    const config = loadConfig();
    logger.info("Configuration loaded successfully");
    return config;
  } catch (e) {
    logger.error(
      `Failed to load configuration: ${e instanceof Error ? e.message : String(e)}`,
    );
    throw e;
  }
}

async function prepareTargetUrls({
  config,
  urlsFromPaths,
}: {
  config: Configuration;
  urlsFromPaths: string[];
}): Promise<{ urlsToRender: string[]; sitemapUrl: string }> {
  const sitemapUrl = config.sitemapUrl || `${config.baseUrl}/sitemap.xml`;
  const sitemapParser = SitemapParser.register({
    sitemapUrl,
    lastmodFilter: config.sitemapUpdatedWithin,
  });
  const urlsFromSitemap = await sitemapParser.parseSitemap();
  // Strip tracking params (?utm_*, click IDs) so URL variants collapse into
  // one render and one cache entry instead of each minting their own.
  const urlsToRender = uniq(
    [...urlsFromPaths, ...urlsFromSitemap].map((url) =>
      stripTrackingParams(normalizeUrl(url)),
    ),
  );
  logger.info(`Prepared ${urlsToRender.length} URLs to render`);
  logger.info(`Base URL: ${config.baseUrl}`);
  urlsToRender.forEach((url, index) => {
    logger.info(`${INDENT}${index + 1}: ${extractPathFromUrl(url)}`);
  });
  return { urlsToRender, sitemapUrl };
}

async function reportResult({
  config,
  urlResultMap,
  urlToOriginalPathMap,
  domain,
  canonicalDomain,
  originHost,
  sitemapUrl,
  sitemapFilter,
  startedAt,
  completedAt,
  userId,
}: {
  config: Configuration;
  urlResultMap: Map<string, PipelineResult>;
  urlToOriginalPathMap: Map<string, string>;
  domain: string;
  canonicalDomain: string;
  originHost: string;
  sitemapUrl: string;
  sitemapFilter: string;
  startedAt: number;
  completedAt: number;
  userId: string;
}): Promise<void> {
  const {
    successUrls,
    countRendered,
    countKvSynced,
    countR2Synced,
    failedToRenderUrls,
    failedToSyncUrls,
  } = urlResultMap.values().reduce<{
    successUrls: string[];
    countRendered: number;
    countKvSynced: number;
    countR2Synced: number;
    failedToRenderUrls: { url: string; failure: PrerenderFailureDetail }[];
    failedToSyncUrls: string[];
  }>(
    (acc, result) => {
      if (result.isRendered) {
        acc.countRendered++;
      }
      if (result.isCachedToKv) {
        acc.countKvSynced++;
      }
      if (result.isCachedToR2) {
        acc.countR2Synced++;
      }
      if (!result.isRendered) {
        acc.failedToRenderUrls.push({
          url: result.url,
          failure: result.failure ?? { reason: "unknown" },
        });
      }
      if (result.isRendered && (!result.isCachedToKv || !result.isCachedToR2)) {
        acc.failedToSyncUrls.push(result.url);
      }
      if (result.isRendered && result.isCachedToKv && result.isCachedToR2) {
        acc.successUrls.push(result.url);
      }
      return acc;
    },
    {
      successUrls: [],
      countRendered: 0,
      countKvSynced: 0,
      countR2Synced: 0,
      failedToRenderUrls: [],
      failedToSyncUrls: [],
    },
  );
  const resolvePath = (url: string) =>
    urlToOriginalPathMap.get(url) ?? extractPathFromUrl(url);
  const resultBody: ReportResultBody = {
    batch_id: config.batchId,
    user_id: userId,
    source: config.requestSource,
    google_cloud_execution_id: process.env.CLOUD_RUN_EXECUTION ?? "local",
    domain,
    canonical_domain: canonicalDomain,
    origin_host: originHost,
    urls_rendered: countRendered,
    urls_synced_r2: countR2Synced,
    urls_synced_kv: countKvSynced,
    sitemap_url: sitemapUrl,
    sitemap_filter: sitemapFilter,
    started_at: DateTime.fromMillis(startedAt).toUTC().toISO()!,
    finished_at: DateTime.fromMillis(completedAt).toUTC().toISO()!,
    product_type: config.productType,
    failed: {
      failed_to_render: {
        paths: failedToRenderUrls.map(({ url, failure }) => ({
          path: resolvePath(url),
          error: failure,
        })),
        count: failedToRenderUrls.length,
      },
      failed_to_sync: {
        paths: failedToSyncUrls.map((url) => ({
          path: resolvePath(url),
          error: { reason: "sync_failed" as const },
        })),
        count: failedToSyncUrls.length,
      },
    },
  };

  logger.info(`Batch result: ${JSON.stringify(resultBody, null, 2)}`);

  if (config.retryOptions) {
    try {
      resultBody.retry_options = JSON.parse(config.retryOptions) as {
        parent_batch_group_ids: string[];
        parent_execution_ids: string[];
        retry_count: number;
      };
    } catch (e) {
      logger.error(`Failed to parse retry options`, e);
    }
  }
  const isFinalRetryRun =
    resultBody.retry_options?.retry_count &&
    resultBody.retry_options.retry_count === 2;
  const hasFailedCases =
    failedToRenderUrls.length > 0 || failedToSyncUrls.length > 0;
  const shouldSendToTelegram =
    isFinalRetryRun || (hasFailedCases && resultBody.source === "manual");
  if (
    config.telegramBotToken &&
    config.telegramChatId &&
    shouldSendToTelegram
  ) {
    logger.info(`Sending result to Telegram chat: ${config.telegramChatId}`);
    const telegramBot = new TelegramBot(config.telegramBotToken);
    const parentBatchGroupIds =
      resultBody.retry_options?.parent_batch_group_ids ?? [];
    const parentExecutionIds =
      resultBody.retry_options?.parent_execution_ids ?? [];
    const lines = [
      isFinalRetryRun
        ? `*🔁 Final retry run*`
        : `*⚠️ Manual run finished with failures*`,
      ``,
      `*source:* ${escapeMarkdownV2(resultBody.source)}`,
      `*batch:* \`${escapeMarkdownV2(resultBody.batch_id)}\``,
      `*user id:* \`${escapeMarkdownV2(resultBody.user_id)}\``,
      `*domain:* ${escapeMarkdownV2(resultBody.domain)}`,
      `*origin host:* ${escapeMarkdownV2(resultBody.origin_host)}`,
      `*execution:* \`${escapeMarkdownV2(resultBody.google_cloud_execution_id)}\``,
      ``,
      `*result:* success: ${successUrls.length}, render\\_failed: ${failedToRenderUrls.length}, sync\\_failed: ${failedToSyncUrls.length}`,
    ];
    const failureCounts = countFailuresByReason(
      failedToRenderUrls.map(({ failure }) => failure),
    );
    if (failedToSyncUrls.length > 0) {
      failureCounts.sync_failed =
        (failureCounts.sync_failed ?? 0) + failedToSyncUrls.length;
    }
    if (Object.keys(failureCounts).length > 0) {
      lines.push(
        `*failures by reason:* ${escapeMarkdownV2(
          Object.entries(failureCounts)
            .map(([reason, count]) => `${reason}: ${count}`)
            .join(", "),
        )}`,
      );
    }
    if (
      isFinalRetryRun &&
      parentBatchGroupIds.length > 0 &&
      parentBatchGroupIds[0]
    ) {
      lines.push(
        ``,
        `*parent batch group:* \`${escapeMarkdownV2(parentBatchGroupIds[0])}\``,
      );
      if (parentExecutionIds.length > 0) {
        lines.push(
          `*parent executions:* \`${escapeMarkdownV2(parentExecutionIds.join(", "))}\``,
        );
      }
    }

    const telegramMessage = lines.join("\n").slice(0, 4096);
    try {
      await Promise.race([
        telegramBot.sendMessage(config.telegramChatId, telegramMessage, {
          parse_mode: "MarkdownV2",
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Telegram send timeout")), 10000),
        ),
      ]);
      logger.info(`Result sent to Telegram successfully`);
    } catch (e) {
      logger.error(`Failed to send result to Telegram`, e);
    }
  }

  if (config.webhookUrl) {
    const webhookBody = JSON.stringify({
      ...resultBody,
      success_paths: successUrls.map(resolvePath),
    });
    const curlCommand = `curl -X POST '${config.webhookUrl}' -H 'Content-Type: application/json' -H 'x-webhook-signature: ${config.webhookSignature ?? ""}' -d '${webhookBody.replace(/'/g, "'\\''")}'`;
    logger.info(`Calling webhook endpoint: ${config.webhookUrl}`);
    logger.info(`Equivalent curl command:\n${curlCommand}`);
    try {
      await backOff(
        async () => {
          const res = await fetch(config.webhookUrl!, {
            method: "POST",
            body: webhookBody,
            headers: {
              "Content-Type": "application/json",
              "x-webhook-signature": config.webhookSignature ?? "",
            },
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) {
            throw new Error(
              `Webhook returned ${res.status}: ${res.statusText}`,
            );
          }
          return res;
        },
        {
          numOfAttempts: 3,
          startingDelay: 1_000,
          retry: (e, attemptNumber) => {
            logger.warn(
              `Webhook attempt ${attemptNumber} failed: ${e instanceof Error ? e.message : String(e)}`,
            );
            return true;
          },
        },
      );
      logger.info(`Webhook called successfully`);
    } catch (e) {
      logger.error(`Failed to call webhook after 3 attempts`, e);
    }
  }
}

async function launchBrowser(): Promise<Browser> {
  try {
    const browser = await puppeteer.launch({
      executablePath: "/usr/bin/chrome",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        // "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--no-first-run",
        "--disable-background-networking",
      ],
    });
    logger.info("Browser launched successfully");
    return browser;
  } catch (e) {
    logger.error(`Failed to launch browser`, e);
    throw e;
  }
}

async function runPipeline({
  pipelineNumber,
  urlToRender,
  cacheTtl,
  config,
  browser,
}: {
  pipelineNumber: number;
  urlToRender: string;
  cacheTtl: number;
  config: Configuration;
  browser: Browser;
}): Promise<PipelineResult> {
  const path = extractPathFromUrl(urlToRender);
  const result: PipelineResult = {
    url: urlToRender,
    cacheTtl,
    isRendered: false,
    isAnalyzed: false,
    isCachedToR2: false,
    isCachedToKv: false,
  };
  logger.info(`[${pipelineNumber}] Processing ${urlToRender}`);

  // A soft-404 result usually means the snapshot caught the SPA's loading
  // shell (readiness heuristics can fire while a starved renderer still holds
  // the route's Suspense fallback). Retry once with widened stability
  // windows; if the content is still thin after that, cache it as-is — the
  // page may just be genuinely minimal.
  const MAX_CONTENT_ATTEMPTS = 2;
  let renderResult: RenderResult | null = null;
  let preparedHtml = "";
  let dataUrlMap = new Map<string, string>();
  let sanitizedHtml = "";
  let seoAnalysisResult: PageSeoAnalysis | null = null;

  for (let attempt = 1; attempt <= MAX_CONTENT_ATTEMPTS; attempt++) {
    const renderer = RenderEngine.register({
      targetUrl: urlToRender,
      browser,
      userAgent: config.userAgent,
      internalKey: config.internalKey,
      // Renders target the origin host directly, but the page's own absolute
      // URLs hit the customer domain (behind the rate-limiting Fly proxy) —
      // those requests need the key too.
      internalKeyHosts: [config.domain, config.canonicalDomain],
      extendedStability: attempt > 1,
    });

    try {
      renderResult = await renderer.renderPage();
      logger.info(`${INDENT}${INDENT}↳ ${path} - rendering completed`);
    } catch (e) {
      logger.error(`${INDENT}${INDENT}↳ ${path} - rendering failed`, e);
      result.failure = toFailureDetail(e);
      return result;
    }

    // Swap any oversized base64 data URLs for short placeholder tokens so they
    // don't trigger node-html-parser's regex stack overflow. The originals are
    // restored after sanitization, before the HTML is persisted.
    ({ html: preparedHtml, urlMap: dataUrlMap } = extractOversizedDataUrls(
      renderResult.html,
    ));
    if (dataUrlMap.size > 0) {
      logger.info(
        `${INDENT}${INDENT}↳ ${path} - stashed ${dataUrlMap.size} oversized data URL(s) before parsing (${renderResult.html.length} → ${preparedHtml.length} bytes)`,
      );
    }

    // Sanitize rendered HTML: fix metadata, remove noise, inject missing tags
    try {
      sanitizedHtml = sanitizeHtml({
        html: preparedHtml,
        url: renderResult.finalUrl,
        canonicalDomain: config.canonicalDomain,
      });
      logger.debug(`Sanitized HTML: ${sanitizedHtml}`);
    } catch (e) {
      logger.error(
        `${INDENT}${INDENT}↳ ${path} - HTML sanitization failed fallback to original HTML`,
        e,
      );
      sanitizedHtml = preparedHtml;
    }
    logger.info(`${INDENT}${INDENT}↳ ${path} - HTML sanitized`);

    try {
      const analyzer = SeoAnalyzer.register({
        html: sanitizedHtml,
        url: renderResult.finalUrl,
        statusCode: renderResult.statusCode,
        xRobotsTag: renderResult.xRobotsTag ?? null,
      });
      seoAnalysisResult = analyzer.analyze();
      result.isAnalyzed = true;
      logger.info(`${INDENT}${INDENT}↳ ${path} - SEO analysis completed`);
    } catch (e) {
      logger.error(`${INDENT}${INDENT}↳ ${path} - SEO analysis failed`, e);
      result.failure = { reason: "unknown" };
      return result;
    }

    if (!seoAnalysisResult.isSoft404) {
      break;
    }
    if (attempt < MAX_CONTENT_ATTEMPTS) {
      logger.warn(
        `${INDENT}${INDENT}↳ ${path} - soft-404 content (${seoAnalysisResult.wordCount} words), retrying with extended stability windows`,
      );
    }
  }

  if (!renderResult || !seoAnalysisResult) {
    return result;
  }
  if (seoAnalysisResult.isSoft404) {
    logger.warn(
      `${INDENT}${INDENT}↳ ${path} - soft-404 content persisted after retry (${seoAnalysisResult.wordCount} words), caching as-is`,
    );
  }
  result.isRendered = true;

  // Detect SEO metadata lost during sanitization. Both inputs carry the same
  // placeholders, so property-presence comparisons stay accurate.
  try {
    const metadataLoss = detectMetadataLoss(preparedHtml, sanitizedHtml);
    if (metadataLoss.lostProperties.length > 0) {
      logger.warn(
        `${INDENT}${INDENT}↳ ${path} - SEO metadata lost during sanitization: ${metadataLoss.lostProperties.join(", ")}`,
        { originalHtml: renderResult.html, sanitizedHtml },
      );

      if (config.telegramBotToken && config.telegramChatId) {
        const telegramBot = new TelegramBot(config.telegramBotToken);
        const message =
          `⚠️ SEO metadata lost during sanitization\n\nJob ID: ${escapeMarkdownV2(process.env.CLOUD_RUN_EXECUTION ?? "")}\nURL: ${escapeMarkdownV2(urlToRender)}\nPath: ${escapeMarkdownV2(path)}\nLost: ${escapeMarkdownV2(metadataLoss.lostProperties.join(", "))}`.slice(
            0,
            4096,
          );
        try {
          await Promise.race([
            telegramBot.sendMessage(config.telegramChatId, message, {
              parse_mode: "MarkdownV2",
            }),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Telegram send timeout")),
                10000,
              ),
            ),
          ]);
        } catch (e) {
          logger.error(`Failed to send metadata loss alert to Telegram`, e);
        }
      }
    }
  } catch (e) {
    logger.error(
      `${INDENT}${INDENT}↳ ${path} - SEO metadata loss detection failed`,
      e,
    );
  }

  // Restore the stashed data URLs into the final HTML before persistence.
  const finalSanitizedHtml = restoreDataUrls(sanitizedHtml, dataUrlMap);

  // Skip caching if SKIP_CACHE_SYNC is true
  if (config.skipCacheSync) {
    return result;
  }

  // Upload snapshot to R2
  const r2Loader = R2Loader.register({
    targetUrl: renderResult.url,
    html: finalSanitizedHtml,
    seoAnalysis: seoAnalysisResult,
    userAgent: config.userAgent,
    diagnostics: renderResult.diagnostics,
    r2CacheConfig: {
      cfAccountId: config.cfAccountId,
      r2AccessKeyId: config.r2AccessKeyId,
      r2SecretAccessKey: config.r2SecretAccessKey,
      r2BucketName: config.r2BucketName,
      cacheTtl,
    },
  });
  const r2UploadResult = await r2Loader.uploadR2Object();
  result.isCachedToR2 = r2UploadResult.r2Synced;

  if (!r2UploadResult.r2Synced) {
    logger.error(
      `${INDENT}${INDENT}↳ ${path} - uploading snapshot to R2 failed`,
    );
    return result;
  }
  result.payloadForKv = {
    kvRecord: r2UploadResult.kvRecord,
    objectKey: r2UploadResult.objectKey,
  };
  logger.info(`${INDENT}${INDENT}↳ ${path} - snapshot uploaded to R2`);
  return result;
}

async function runPipelineStreams({
  concurrency,
  urlsToRender,
  cacheTtlMap,
  config,
  launchBrowserFn,
}: {
  concurrency: number;
  config: Configuration;
  urlsToRender: string[];
  cacheTtlMap: Map<string, number>;
  launchBrowserFn: () => Promise<Browser>;
}): Promise<{ resultMap: Map<string, PipelineResult> }> {
  const pipelineResults: PipelineResult[] = [];
  // Cap concurrency to the number of URLs so we don't launch idle browsers.
  concurrency = Math.min(concurrency, urlsToRender.length || 1);
  logger.info(
    `Running pipeline with ${concurrency} parallel streams over ${urlsToRender.length} URLs`,
  );
  if (config.skipCacheSync) {
    logger.info(`${INDENT}↳ SKIPPING CACHING: SKIP_CACHE_SYNC is true`);
  }

  // Recycle each stream's browser periodically so long runs don't accumulate
  // Chromium memory bloat.
  const REFRESH_EVERY_RENDERS = 20;
  // Stagger stream start-up so the CPU-heavy boot phase of concurrent renders
  // (bundle parse/eval) doesn't land on the container all at once.
  const STREAM_START_STAGGER_MS = 2_000;

  // Allocate one browser per stream (one per concurrency slot) up front.
  const browsers: (Browser | null)[] = new Array<Browser | null>(
    concurrency,
  ).fill(null);
  for (let slot = 0; slot < concurrency; slot++) {
    try {
      browsers[slot] = await launchBrowserFn();
    } catch (e) {
      logger.error(`[Browser] Failed to launch browser for stream ${slot}`, e);
      browsers[slot] = null;
    }
  }

  const ensureHealthy = async (slot: number): Promise<Browser | null> => {
    const current = browsers[slot];
    if (current && current.connected) {
      return current;
    }
    if (current) {
      await current.close().catch(() => {});
    }
    try {
      const fresh = await launchBrowserFn();
      browsers[slot] = fresh;
      logger.info(`[Browser] Stream ${slot} browser refreshed`);
      return fresh;
    } catch (e) {
      logger.error(
        `[Browser] Failed to relaunch browser for stream ${slot}`,
        e,
      );
      browsers[slot] = null;
      return null;
    }
  };

  // Each stream pulls the next URL as soon as it finishes its current one —
  // no batch barrier, so one slow render never idles the other streams and
  // their next renders never start in lockstep.
  let nextUrlIndex = 0;

  const failedResult = (url: string): PipelineResult => ({
    url,
    cacheTtl: cacheTtlMap.get(url) ?? 604800,
    isRendered: false,
    isAnalyzed: false,
    isCachedToR2: false,
    isCachedToKv: false,
    failure: { reason: "unknown" },
  });

  const runStream = async (slot: number): Promise<void> => {
    if (slot > 0) {
      await sleep(slot * STREAM_START_STAGGER_MS);
    }
    let rendersOnBrowser = 0;
    while (nextUrlIndex < urlsToRender.length) {
      const urlIndex = nextUrlIndex++;
      const url = urlsToRender[urlIndex];
      if (url === undefined) {
        break;
      }
      const cacheTtl = cacheTtlMap.get(url) ?? 604800;

      if (rendersOnBrowser >= REFRESH_EVERY_RENDERS) {
        const b = browsers[slot];
        if (b) await b.close().catch(() => {});
        browsers[slot] = null;
        rendersOnBrowser = 0;
        logger.info(
          `[Browser] Stream ${slot} browser recycled after ${REFRESH_EVERY_RENDERS} renders`,
        );
      }

      const browser = await ensureHealthy(slot);
      if (!browser) {
        pipelineResults.push(failedResult(url));
        continue;
      }
      try {
        pipelineResults.push(
          await runPipeline({
            pipelineNumber: urlIndex + 1,
            urlToRender: url,
            cacheTtl,
            config,
            browser,
          }),
        );
      } catch (e) {
        logger.error(
          `[Stream ${slot}] Pipeline threw for ${extractPathFromUrl(url)}`,
          e,
        );
        // If the browser died mid-render, drop it so the next render relaunches.
        const b = browsers[slot];
        if (b && !b.connected) {
          await b.close().catch(() => {});
          browsers[slot] = null;
        }
        pipelineResults.push(failedResult(url));
      }
      rendersOnBrowser++;
    }
  };

  try {
    await Promise.all(
      Array.from({ length: concurrency }, (_, slot) => runStream(slot)),
    );
  } finally {
    await Promise.all(
      browsers.map((b) => (b ? b.close().catch(() => {}) : Promise.resolve())),
    );
    logger.info(`[Browser] All stream browsers closed`);
  }

  const resultMap = new Map<string, PipelineResult>();
  pipelineResults.forEach((result) => {
    resultMap.set(result.url, result);
  });

  return { resultMap };
}

async function bulkUpdateKv({
  kvPairInfoMap,
  config,
}: {
  kvPairInfoMap: Map<
    string, // kv key
    {
      url: string;
      kvPair: { key: string; value: string; expiration_ttl: number };
    }
  >;
  config: Configuration;
}): Promise<{
  successfulKeyCount: number;
  succeededUrls: string[];
  unsuccessfulUrls: string[];
}> {
  let finalSuccessfulKeyCount = 0;
  let finalUnsuccessfulKeys = [];
  const kvLoader = KvLoader.register({
    kvConfig: {
      cfAccountId: config.cfAccountId,
      cfApiToken: config.cfApiToken,
      kvNamespaceId: config.kvNamespaceId,
    },
  });
  const targetKvPairs = Array.from(kvPairInfoMap.values()).map(
    ({ kvPair }) => kvPair,
  );

  const filteredTargetKvPairs: {
    key: string;
    value: string;
    expiration_ttl: number;
  }[] = [];
  const KV_KEY_LENGTH_LIMIT = 512;
  targetKvPairs.forEach((kvPair) => {
    if (new TextEncoder().encode(kvPair.key).length > KV_KEY_LENGTH_LIMIT) {
      logger.error(`KV key length exceeds limit: ${kvPair.key.length}`);
      finalUnsuccessfulKeys.push(kvPair.key);
    } else {
      filteredTargetKvPairs.push(kvPair);
    }
  });
  const kvUploadResult = await kvLoader.uploadKvRecords({
    kvPairs: filteredTargetKvPairs,
  });

  finalSuccessfulKeyCount += kvUploadResult.successfulKeyCount;
  finalUnsuccessfulKeys.push(...kvUploadResult.unsuccessfulKeys);

  // retry after 10 seconds if unsuccessful
  if (kvUploadResult.unsuccessfulKeys.length > 0) {
    logger.info(
      `Failed to upload ${kvUploadResult.unsuccessfulKeys.length} KV records. Retrying after 10 seconds ...`,
    );
    const kvPairsToRetry = [];
    for (const key of kvUploadResult.unsuccessfulKeys) {
      const kvPairInfo = kvPairInfoMap.get(key);
      if (kvPairInfo) {
        kvPairsToRetry.push(kvPairInfo.kvPair);
      }
    }
    await sleep(10000);
    const retryKvUploadResult = await kvLoader.uploadKvRecords({
      kvPairs: kvPairsToRetry,
    });
    finalSuccessfulKeyCount += retryKvUploadResult.successfulKeyCount;
    finalUnsuccessfulKeys = retryKvUploadResult.unsuccessfulKeys;
  }

  const succeededUrls = [];
  const unsuccessfulUrls = [];
  for (const [key, kvPairInfo] of kvPairInfoMap.entries()) {
    if (finalUnsuccessfulKeys.includes(key)) {
      unsuccessfulUrls.push(kvPairInfo.url);
    } else {
      succeededUrls.push(kvPairInfo.url);
    }
  }
  if (unsuccessfulUrls.length > 0) {
    logger.error(`KV sync failed for following paths:`);
    unsuccessfulUrls.forEach((url) => {
      logger.error(`${INDENT}${INDENT}↳ ${url}`);
    });
  } else {
    logger.info(`KV sync completed successfully`);
  }
  return {
    successfulKeyCount: finalSuccessfulKeyCount,
    succeededUrls,
    unsuccessfulUrls,
  };
}

async function main(): Promise<void> {
  const config = getConfig();
  const startedAt = Date.now();

  // STEP 1 : Prepare target URLs
  // Build URL-to-TTL map from pathsList
  const cacheTtlMap = new Map<string, number>();
  const urlToOriginalPathMap = new Map<string, string>();
  const urlsFromPaths = config.pathsList.map((entry) => {
    const url = stripTrackingParams(
      normalizeUrl(`${config.baseUrl}${entry.path}`),
    );
    let encodedUrl: string;
    try {
      encodedUrl = encodeURI(decodeURI(url));
    } catch {
      encodedUrl = url;
    }
    cacheTtlMap.set(encodedUrl, entry.ttl);
    urlToOriginalPathMap.set(encodedUrl, entry.path);
    return encodedUrl;
  });

  let urlsToRender: string[] = [...urlsFromPaths];
  let sitemapUrl: string = "";
  if (config.skipSitemapParsing) {
    logger.info(`SKIPPING SITEMAP PARSING: SKIP_SITEMAP_PARSING is true`);
    urlsToRender = urlsFromPaths;
    sitemapUrl = "skipped";
  } else {
    const result = await prepareTargetUrls({ config, urlsFromPaths });
    urlsToRender = result.urlsToRender;
    sitemapUrl = result.sitemapUrl;
  }

  // STEP 2+3 : Run the pipeline streams (one browser per stream).
  const { resultMap: urlResultMap } = await runPipelineStreams({
    concurrency: config.concurrency,
    urlsToRender,
    cacheTtlMap,
    config,
    launchBrowserFn: launchBrowser,
  });

  if (config.skipCacheSync) {
    logger.info(`SKIPPING KV UPLOAD: SKIP_CACHE_SYNC is true`);
  } else {
    const kvPairInfoMap = new Map<
      string, // kv key
      {
        url: string;
        kvPair: { key: string; value: string; expiration_ttl: number };
      }
    >();
    const objectKeyMap = new Map<string, string>();
    urlResultMap.forEach((result) => {
      if (result.payloadForKv) {
        const kvKey = buildKvKey({ targetUrl: result.url });
        kvPairInfoMap.set(kvKey, {
          url: result.url,
          kvPair: {
            key: kvKey,
            value: JSON.stringify(result.payloadForKv.kvRecord),
            expiration_ttl: result.cacheTtl,
          },
        });
        objectKeyMap.set(kvKey, result.payloadForKv.objectKey);
      }
    });

    // STEP 4 : Invalidate stale R2 objects
    // const cacheInvalidator = CacheInvalidator.register({
    //   cacheConfig: {
    //     cfAccountId: config.cfAccountId,
    //     cfApiToken: config.cfApiToken,
    //     r2AccessKeyId: config.r2AccessKeyId,
    //     r2SecretAccessKey: config.r2SecretAccessKey,
    //     r2BucketName: config.r2BucketName,
    //     kvNamespaceId: config.kvNamespaceId,
    //   },
    // });
    // await cacheInvalidator.invalidateMultipleStaleR2Objects({
    //   kvKeyObjectKeyMap: objectKeyMap,
    // });

    // STEP 5 : Upload KV records (URL meta)
    const { succeededUrls, unsuccessfulUrls } = await bulkUpdateKv({
      kvPairInfoMap,
      config,
    });
    for (const url of succeededUrls) {
      const result = urlResultMap.get(url);
      if (result) {
        result.isCachedToKv = true;
      }
    }
    for (const url of unsuccessfulUrls) {
      const result = urlResultMap.get(url);
      if (result) {
        result.isCachedToKv = false;
      }
    }
  }

  const completedAt = Date.now();

  // STEP 6 : Report result
  await reportResult({
    config,
    urlResultMap,
    urlToOriginalPathMap,
    domain: config.domain,
    canonicalDomain: config.canonicalDomain,
    originHost: config.originHost,
    sitemapUrl,
    sitemapFilter: config.skipSitemapParsing
      ? "skipped"
      : config.sitemapUpdatedWithin,
    startedAt,
    completedAt,
    userId: config.userId,
  });
}

// Catch unhandled rejections from stray async errors (Node 22 terminates on these)
process.on("unhandledRejection", (reason) => {
  logger.error("[FATAL] Unhandled rejection:", reason);
  process.exit(1);
});

main()
  .then(() => {
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error(
      `Failed to run main: ${error instanceof Error ? error.message : String(error)}`,
    );
    // Read Telegram config directly from env as fallback (config may not have loaded)
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;
    if (telegramBotToken && telegramChatId) {
      const telegramBot = new TelegramBot(telegramBotToken);
      try {
        await Promise.race([
          telegramBot.sendMessage(
            telegramChatId,
            `Failed to execute the job:\n\`\`\`json\n${escapeMarkdownV2Code(
              JSON.stringify(
                {
                  google_cloud_execution_id:
                    process.env.CLOUD_RUN_EXECUTION ?? "local",
                  failReason:
                    error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            )}\n\`\`\``.slice(0, 4096),
            {
              parse_mode: "MarkdownV2",
            },
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Telegram send timeout")), 10000),
          ),
        ]);
        logger.info(`Error sent to Telegram successfully`);
      } catch (e) {
        logger.error(
          `Failed to send error to Telegram: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    process.exit(1);
  });
