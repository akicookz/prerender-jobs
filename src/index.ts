import { uniq } from "es-toolkit";
import { DateTime } from "luxon";
import * as TelegramBot from "node-telegram-bot-api";
import normalizeUrl from "normalize-url";
import puppeteer, { Browser } from "puppeteer-core";
import { getHostname } from "tldts";
import { CacheInvalidator } from "./cache-manager/cache-invalidator";
import { buildKvKey } from "./cache-manager/kv-key-utils";
import { KvLoader } from "./cache-manager/kv-loader";
import { R2Loader } from "./cache-manager/r2-loader";
import { KvRecord } from "./cache-manager/type";
import { loadConfig, type Configuration } from "./load-config";
import { AppLogger, INDENT } from "./logger";
import { RenderEngine, type RenderResult } from "./render-engine";
import { SeoAnalyzer } from "./seo-analyzer/index";
import type { PageSeoAnalysis } from "./seo-analyzer/type";
import { SitemapParser } from "./sitemap-parser";
import { extractPathFromUrl, sleep } from "./util";

interface PipelineResult {
  url: string;
  isRendered: boolean;
  isAnalyzed: boolean;
  isCachedToR2: boolean;
  isCachedToKv: boolean;
  payloadForKv?: {
    kvRecord: KvRecord;
    objectKey: string;
  };
}

interface ReportResultBody {
  batch_id: string;
  source: string;
  google_cloud_execution_id: string;
  domain: string;
  origin_host: string;
  urls_rendered: number;
  urls_synced_r2: number;
  urls_synced_kv: number;
  sitemap_url: string;
  sitemap_filter: string;
  started_at: string;
  finished_at: string;
  failed: {
    failed_to_render: {
      paths: string[];
      count: number;
    };
    failed_to_sync: {
      paths: string[];
      count: number;
    };
  };
  retry_options?: {
    parent_batch_group_ids: string[];
    retry_count: number;
  };
}

const logger = AppLogger.register({ prefix: "index" });
const config = getConfig();

function getConfig(): Configuration {
  try {
    const config = loadConfig();
    logger.info("Configuration loaded successfully:");
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
}: {
  config: Configuration;
}): Promise<{ urlsToRender: string[]; sitemapUrl: string }> {
  const sitemapUrl =
    config.sitemapUrl ||
    `https://${getHostname(config.urlList[0]!)}/sitemap.xml`;
  const sitemapParser = SitemapParser.register({
    sitemapUrl,
    lastmodFilter: config.sitemapUpdatedWithin,
  });
  const urlsFromSitemap = await sitemapParser.parseSitemap();
  const urlsToRender = uniq(
    [...config.urlList, ...urlsFromSitemap].map((url) => normalizeUrl(url)),
  );
  logger.info(`Prepared ${urlsToRender.length} URLs to render`);
  logger.info(`Base URL: ${getHostname(urlsToRender[0]!)}`);
  urlsToRender.forEach((url, index) => {
    logger.info(`${INDENT}${index + 1}: ${extractPathFromUrl(url)}`);
  });
  return { urlsToRender, sitemapUrl };
}

async function reportResult({
  config,
  urlResultMap,
  domain,
  originHost,
  sitemapUrl,
  sitemapFilter,
  startedAt,
  completedAt,
}: {
  config: Configuration;
  urlResultMap: Map<string, PipelineResult>;
  domain: string;
  originHost: string;
  sitemapUrl: string;
  sitemapFilter: string;
  startedAt: number;
  completedAt: number;
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
    failedToRenderUrls: string[];
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
        acc.failedToRenderUrls.push(result.url);
      }
      if (!result.isCachedToKv || !result.isCachedToR2) {
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
  const resultBody: ReportResultBody = {
    batch_id: config.batchId,
    source: config.requestSource,
    google_cloud_execution_id: process.env.CLOUD_RUN_EXECUTION ?? "local",
    domain,
    origin_host: originHost,
    urls_rendered: countRendered,
    urls_synced_r2: countR2Synced,
    urls_synced_kv: countKvSynced,
    sitemap_url: sitemapUrl,
    sitemap_filter: sitemapFilter,
    started_at: DateTime.fromMillis(startedAt).toUTC().toISO()!,
    finished_at: DateTime.fromMillis(completedAt).toUTC().toISO()!,
    failed: {
      failed_to_render: {
        paths: failedToRenderUrls.map((url) => extractPathFromUrl(url)),
        count: failedToRenderUrls.length,
      },
      failed_to_sync: {
        paths: failedToSyncUrls.map((url) => extractPathFromUrl(url)),
        count: failedToSyncUrls.length,
      },
    },
  };

  logger.info(`Batch result: ${JSON.stringify(resultBody, null, 2)}`);

  if (config.retryOptions) {
    try {
      resultBody.retry_options = JSON.parse(config.retryOptions) as {
        parent_batch_group_ids: string[];
        retry_count: number;
      };
    } catch (e) {
      logger.error(
        `Failed to parse retry options: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const isRetryRun =
    resultBody.retry_options?.retry_count &&
    resultBody.retry_options.retry_count > 0;
  const hasFailedCases =
    failedToRenderUrls.length > 0 || failedToSyncUrls.length > 0;
  const shouldSendToTelegram = hasFailedCases || isRetryRun;
  if (
    config.telegramBotToken &&
    config.telegramChatId &&
    shouldSendToTelegram
  ) {
    logger.info(`Sending result to Telegram chat: ${config.telegramChatId}`);
    const telegramBot = new TelegramBot(config.telegramBotToken);
    const resultBodyForTelegram = structuredClone(resultBody);
    const allFailedToRenderPaths =
      resultBodyForTelegram.failed.failed_to_render.paths;
    if (allFailedToRenderPaths.length > 50) {
      resultBodyForTelegram.failed.failed_to_render.paths =
        allFailedToRenderPaths.slice(0, 50);
      resultBodyForTelegram.failed.failed_to_render.paths.push(
        `...${allFailedToRenderPaths.length - 50} more`,
      );
    }
    const allFailedToSyncPaths =
      resultBodyForTelegram.failed.failed_to_sync.paths;
    if (allFailedToSyncPaths.length > 50) {
      resultBodyForTelegram.failed.failed_to_sync.paths =
        allFailedToSyncPaths.slice(0, 50);
      resultBodyForTelegram.failed.failed_to_sync.paths.push(
        `...${allFailedToSyncPaths.length - 50} more`,
      );
    }
    try {
      await telegramBot.sendMessage(
        config.telegramChatId,
        `\`\`\`json\n${JSON.stringify(resultBodyForTelegram, null, 2).slice(
          0,
          4096,
        )}\n\`\`\``, // Telegram message length limit is 4096 characters
        {
          parse_mode: "MarkdownV2",
        },
      );
      logger.info(`Result sent to Telegram successfully`);
    } catch (e) {
      logger.error(
        `Failed to send result to Telegram: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (config.webhookUrl) {
    logger.info(`Calling webhook endpoint: ${config.webhookUrl}`);
    try {
      const response = await fetch(config.webhookUrl, {
        method: "POST",
        body: JSON.stringify({
          ...resultBody,
          success_paths: successUrls.map((url) => extractPathFromUrl(url)),
        }),
        headers: {
          "Content-Type": "application/json",
          "x-webhook-signature": config.webhookSignature ?? "",
        },
      });
      if (!response.ok) {
        logger.error(`Failed to call webhook: ${response.statusText}`);
      }
      logger.info(`Webhook called successfully`);
    } catch (e) {
      logger.error(
        `Failed to call webhook: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

async function launchBrowser(): Promise<Browser> {
  try {
    const browser = await puppeteer.launch({
      executablePath: "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    logger.info("Browser launched successfully");
    return browser;
  } catch (e) {
    logger.error(
      `Failed to launch browser: ${e instanceof Error ? e.message : String(e)}`,
    );
    throw e;
  }
}

async function runPipeline({
  pipelineNumber,
  urlToRender,
  config,
  browser,
}: {
  pipelineNumber: number;
  urlToRender: string;
  config: Configuration;
  browser: Browser;
}): Promise<PipelineResult> {
  const path = extractPathFromUrl(urlToRender);
  const result: PipelineResult = {
    url: urlToRender,
    isRendered: false,
    isAnalyzed: false,
    isCachedToR2: false,
    isCachedToKv: false,
  };
  logger.info(`[${pipelineNumber}] Processing ${urlToRender}`);
  const renderer = RenderEngine.register({
    targetUrl: urlToRender,
    browser,
    userAgent: config.userAgent,
  });

  let renderResult: RenderResult;
  try {
    renderResult = await renderer.renderPage();
    result.isRendered = true;
    logger.info(`${INDENT}${INDENT}↳ ${path} - rendering completed`);
  } catch (e) {
    logger.error(
      `${INDENT}${INDENT}↳ ${path} - rendering failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return result;
  }

  let seoAnalysisResult: PageSeoAnalysis | null = null;
  try {
    const analyzer = SeoAnalyzer.register({
      html: renderResult.html,
      url: renderResult.finalUrl,
      statusCode: renderResult.statusCode,
      xRobotsTag: renderResult.xRobotsTag ?? null,
    });
    seoAnalysisResult = analyzer.analyze();
    result.isAnalyzed = true;
    logger.info(`${INDENT}${INDENT}↳ ${path} - SEO analysis completed`);
  } catch (e) {
    logger.error(
      `${INDENT}${INDENT}↳ ${path} - SEO analysis failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return result;
  }

  // Skip caching if SKIP_CACHE_SYNC is true
  if (config.skipCacheSync) {
    return result;
  }

  // Upload snapshot to R2
  const r2Loader = R2Loader.register({
    targetUrl: renderResult.finalUrl,
    html: renderResult.html,
    seoAnalysis: seoAnalysisResult,
    userAgent: config.userAgent,
    r2CacheConfig: {
      cfAccountId: config.cfAccountId,
      r2AccessKeyId: config.r2AccessKeyId,
      r2SecretAccessKey: config.r2SecretAccessKey,
      r2BucketName: config.r2BucketName,
      cacheTtl: config.cacheTtl,
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

async function runPipelineBatches({
  concurrency,
  browser,
  urlsToRender,
  config,
}: {
  concurrency: number;
  browser: Browser;
  config: Configuration;
  urlsToRender: string[];
}): Promise<Map<string, PipelineResult>> {
  const pipelineResults: PipelineResult[] = [];
  const totalNumberOfBatches = Math.ceil(urlsToRender.length / concurrency);
  logger.info(`Running pipeline batches with concurrency: ${concurrency}`);
  logger.info(`${INDENT}↳ ${totalNumberOfBatches} batches`);
  if (config.skipCacheSync) {
    logger.info(`${INDENT}↳ SKIPPING CACHING: SKIP_CACHE_SYNC is true`);
  }
  let processedCount = 0;
  for (let i = 0; i < urlsToRender.length; i += concurrency) {
    logger.info(
      `Start batch ${i / concurrency + 1} of ${totalNumberOfBatches}`,
    );
    const batchUrls = urlsToRender.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batchUrls.map((url, index) =>
        runPipeline({
          pipelineNumber: processedCount + index + 1,
          urlToRender: url,
          config,
          browser,
        }),
      ),
    );
    pipelineResults.push(...batchResults);
    processedCount += batchUrls.length;
  }

  const resultMap = new Map<string, PipelineResult>();
  pipelineResults.forEach((result) => {
    resultMap.set(result.url, result);
  });

  return resultMap;
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
  const kvUploadResult = await kvLoader.uploadKvRecords({
    kvPairs: targetKvPairs,
  });

  finalSuccessfulKeyCount = kvUploadResult.successfulKeyCount;
  finalUnsuccessfulKeys = kvUploadResult.unsuccessfulKeys;

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

async function main({ config }: { config: Configuration }): Promise<void> {
  const startedAt = Date.now();

  // STEP 1 : Prepare target URLs
  let urlsToRender: string[] = [...config.urlList];
  let sitemapUrl: string = "";
  if (config.skipSitemapParsing) {
    logger.info(`SKIPPING SITEMAP PARSING: SKIP_SITEMAP_PARSING is true`);
    urlsToRender = config.urlList;
    sitemapUrl = "skipped";
  } else {
    const result = await prepareTargetUrls({ config });
    urlsToRender = result.urlsToRender;
    sitemapUrl = result.sitemapUrl;
  }

  // STEP 2 : Launch browser
  const browser = await launchBrowser();

  // STEP 3 : Run the pipeline batches
  const urlResultMap = await runPipelineBatches({
    concurrency: config.concurrency,
    browser,
    urlsToRender,
    config,
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
            expiration_ttl: config.cacheTtl,
          },
        });
        objectKeyMap.set(kvKey, result.payloadForKv.objectKey);
      }
    });

    // STEP 4 : Invalidate stale R2 objects
    const cacheInvalidator = CacheInvalidator.register({
      cacheConfig: {
        cfAccountId: config.cfAccountId,
        cfApiToken: config.cfApiToken,
        r2AccessKeyId: config.r2AccessKeyId,
        r2SecretAccessKey: config.r2SecretAccessKey,
        r2BucketName: config.r2BucketName,
        kvNamespaceId: config.kvNamespaceId,
      },
    });
    await cacheInvalidator.invalidateMultipleStaleR2Objects({
      kvKeyObjectKeyMap: objectKeyMap,
    });

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

  // STEP 5 : Report result

  await reportResult({
    config,
    urlResultMap,
    domain: config.domain,
    originHost: config.originHost,
    sitemapUrl,
    sitemapFilter: config.skipSitemapParsing
      ? "skipped"
      : config.sitemapUpdatedWithin,
    startedAt,
    completedAt,
  });
}

main({ config })
  .then(() => {
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error(
      `Failed to run main: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (config.telegramBotToken && config.telegramChatId) {
      const telegramBot = new TelegramBot(config.telegramBotToken);
      try {
        await telegramBot.sendMessage(
          config.telegramChatId,
          `Failed to execute the job:\n\`\`\`json\n${JSON.stringify(
            {
              google_cloud_execution_id:
                process.env.CLOUD_RUN_EXECUTION ?? "local",
              failReason:
                error instanceof Error ? error.message : String(error),
            },
            null,
            2,
          )}\n\`\`\``.slice(0, 4096), // Telegram message length limit is 4096 characters
          {
            parse_mode: "MarkdownV2",
          },
        );
        logger.info(`Error sent to Telegram successfully`);
      } catch (e) {
        logger.error(
          `Failed to send error to Telegram: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    process.exit(1);
  });
