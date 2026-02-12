import { uniq } from "es-toolkit";
import normalizeUrl from "normalize-url";
import { getDomain, getHostname } from "tldts";
import { CacheManager } from "./cache-manager/index.js";
import { loadConfig, type Configuration } from "./load-config.js";
import { AppLogger } from "./logger.js";
import {
  RenderEngine,
  type FailedRenderResult,
  type SuccessfulRenderResult,
} from "./render-engine.js";
import { SeoAnalyzer } from "./seo-analyzer/index.js";
import type { PageSeoAnalysis } from "./seo-analyzer/type.js";
import { SitemapParser } from "./sitemap-parser.js";
import { extractPathFromUrl } from "./util.js";

const logger = AppLogger.register({ prefix: "index" });

export interface AnalysisResult {
  renderResult: SuccessfulRenderResult;
  seoAnalysisResult: PageSeoAnalysis | null;
}

export type CacheSyncResult = AnalysisResult & {
  kvSynced: boolean;
  r2Synced: boolean;
};

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
    config.sitemapUrl ??
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
    logger.info(`  - ${index + 1}: ${extractPathFromUrl(url)}`);
  });
  return { urlsToRender, sitemapUrl };
}

async function renderPages({
  config,
  urlsToRender,
}: {
  config: Configuration;
  urlsToRender: string[];
}): Promise<{
  successfulResults: SuccessfulRenderResult[];
  failedResults: FailedRenderResult[];
}> {
  const renderer = RenderEngine.register({
    targetUrls: urlsToRender,
    userAgent: config.userAgent,
    concurrency: config.concurrency,
  });
  const { successfulResults, failedResults } = await renderer.renderAll();
  logger.info(`Successfully rendered ${successfulResults.length} URLs`);
  if (failedResults.length > 0) {
    logger.info(`Failed to render ${failedResults.length} URLs`);
  }
  return { successfulResults, failedResults };
}

function analyzeSeo({
  successfulResults,
}: {
  successfulResults: SuccessfulRenderResult[];
}): {
  renderResult: SuccessfulRenderResult;
  seoAnalysisResult: PageSeoAnalysis | null;
}[] {
  logger.info(`Extracting SEO data for ${successfulResults.length} URLs`);
  const seoAnalysisResults = successfulResults.map((result) => {
    try {
      const analyzer = SeoAnalyzer.register({
        html: result.html,
        url: result.finalUrl,
        statusCode: result.statusCode,
        xRobotsTag: result.xRobotsTag ?? null,
      });
      return analyzer.analyze();
    } catch {
      return null;
    }
  });
  logger.info(`SEO analysis completed for ${seoAnalysisResults.length} URLs`);
  return successfulResults.map((result, index) => ({
    renderResult: result,
    seoAnalysisResult: seoAnalysisResults[index] ?? null,
  }));
}

async function syncCache({
  config,
  seoAnalysisResults,
}: {
  config: Configuration;
  seoAnalysisResults: AnalysisResult[];
}): Promise<CacheSyncResult[]> {
  const cacheSyncResults: CacheSyncResult[] = [];
  for (const result of seoAnalysisResults) {
    if (!result.seoAnalysisResult) {
      logger.warn(
        `No SEO analysis result for ${result.renderResult.finalUrl}, skipping cache sync`,
      );
      cacheSyncResults.push({
        renderResult: result.renderResult,
        seoAnalysisResult: null,
        kvSynced: false,
        r2Synced: false,
      });
      continue;
    }
    const cacheManager = CacheManager.register({
      targetUrl: result.renderResult.finalUrl,
      html: result.renderResult.html,
      seoAnalysis: result.seoAnalysisResult,
      userAgent: config.userAgent,
      cacheConfig: {
        cacheTtl: config.cacheTtl,
        cfAccountId: config.cfAccountId,
        cfApiToken: config.cfApiToken,
        r2AccessKeyId: config.r2AccessKeyId,
        r2SecretAccessKey: config.r2SecretAccessKey,
        r2BucketName: config.r2BucketName,
        kvNamespaceId: config.kvNamespaceId,
      },
    });
    const { kvSynced, r2Synced } = await cacheManager.uploadCache();
    cacheSyncResults.push({
      renderResult: result.renderResult,
      seoAnalysisResult: result.seoAnalysisResult,
      kvSynced,
      r2Synced,
    });
  }
  return cacheSyncResults;
}

async function callWebhook({
  cacheSyncResults,
  domain,
  webhookUrl,
  sitemapUrl,
  sitemapFilter,
  startedAt,
  completedAt,
  failedToRender,
}: {
  cacheSyncResults: CacheSyncResult[];
  domain: string;
  webhookUrl: string;
  sitemapUrl: string;
  sitemapFilter: string;
  startedAt: number;
  completedAt: number;
  failedToRender: FailedRenderResult[];
}): Promise<void> {
  logger.info("Calling webhook");

  const webhookBody = {
    run_id: startedAt,
    domain,
    urls_rendered: cacheSyncResults.length,
    urls_synced_r2: cacheSyncResults.filter((result) => result.r2Synced).length,
    urls_synced_kv: cacheSyncResults.filter((result) => result.kvSynced).length,
    sitemap_url: sitemapUrl,
    sitemap_filter: sitemapFilter,
    started_at: startedAt,
    finished_at: completedAt,
    failed: {
      failed_to_render: {
        urls: failedToRender.map((result) => result.url),
        count: failedToRender.length,
      },
      failed_to_sync: {
        urls: cacheSyncResults
          .filter((result) => !result.r2Synced || !result.kvSynced)
          .map((result) => result.renderResult.finalUrl),
        count: cacheSyncResults.filter(
          (result) => !result.r2Synced || !result.kvSynced,
        ).length,
      },
    },
  };
  const response = await fetch(webhookUrl, {
    method: "POST",
    body: JSON.stringify(webhookBody),
    headers: {
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    logger.error(`Failed to call webhook: ${response.statusText}`);
  }
  logger.info(`Webhook called successfully`);
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = getConfig();

  // STEP 1 : Prepare target URLs
  const { urlsToRender, sitemapUrl } = await prepareTargetUrls({ config });

  // STEP 2 : Pre-render pages
  const { successfulResults, failedResults } = await renderPages({
    config,
    urlsToRender,
  });

  // STEP 3 : Extract SEO data
  const seoAnalysisResults = analyzeSeo({ successfulResults });

  // STEP 4 : Sync to Cloudflare R2 and KV
  let cacheSyncResults: CacheSyncResult[] = [];
  if (!config.skipCacheSync) {
    cacheSyncResults = await syncCache({ config, seoAnalysisResults });
  } else {
    logger.info("Skipping cache sync");
  }

  const completedAt = Date.now();

  // STEP 5 : Call webhook
  if (!config.webhookUrl) {
    logger.info("No webhook URL configured, skipping webhook");
    return;
  }
  const domain = getDomain(cacheSyncResults[0]!.renderResult.finalUrl)!;
  await callWebhook({
    cacheSyncResults,
    domain,
    webhookUrl: config.webhookUrl,
    sitemapUrl,
    sitemapFilter: config.sitemapUpdatedWithin,
    startedAt,
    completedAt,
    failedToRender: failedResults,
  });
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
