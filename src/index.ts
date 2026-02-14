import { uniq } from "es-toolkit";
import normalizeUrl from "normalize-url";
import puppeteer, { Browser } from "puppeteer-core";
import { getDomain, getHostname } from "tldts";
import { CacheManager } from "./cache-manager/index";
import { loadConfig, type Configuration } from "./load-config";
import { AppLogger, INDENT } from "./logger";
import { RenderEngine, type RenderResult } from "./render-engine";
import { SeoAnalyzer } from "./seo-analyzer/index";
import type { PageSeoAnalysis } from "./seo-analyzer/type";
import { SitemapParser } from "./sitemap-parser";
import { extractPathFromUrl } from "./util";

const logger = AppLogger.register({ prefix: "index" });

interface PipelineResult {
  url: string;
  isRendered: boolean;
  isAnalyzed: boolean;
  isCachedToR2: boolean;
  isCachedToKV: boolean;
}

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
  domain,
  countRendered,
  countKvSynced,
  countR2Synced,
  sitemapUrl,
  sitemapFilter,
  startedAt,
  completedAt,
  failedToRenderUrls,
  failedToSyncUrls,
}: {
  config: Configuration;
  domain: string;
  countRendered: number;
  countKvSynced: number;
  countR2Synced: number;
  sitemapUrl: string;
  sitemapFilter: string;
  startedAt: number;
  completedAt: number;
  failedToRenderUrls: string[];
  failedToSyncUrls: string[];
}): Promise<void> {
  const resultBody = {
    run_id: startedAt,
    domain,
    urls_rendered: countRendered,
    urls_synced_r2: countR2Synced,
    urls_synced_kv: countKvSynced,
    sitemap_url: sitemapUrl,
    sitemap_filter: sitemapFilter,
    started_at: startedAt,
    finished_at: completedAt,
    failed: {
      failed_to_render: {
        urls: failedToRenderUrls,
        count: failedToRenderUrls.length,
      },
      failed_to_sync: {
        urls: failedToSyncUrls,
        count: failedToSyncUrls.length,
      },
    },
  };
  if (config.webhookUrl) {
    logger.info(`Calling webhook endpoint: ${config.webhookUrl}`);
    const response = await fetch(config.webhookUrl, {
      method: "POST",
      body: JSON.stringify(resultBody),
      headers: {
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      logger.error(`Failed to call webhook: ${response.statusText}`);
    }
    logger.info(`Webhook called successfully`);
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
    isCachedToKV: false,
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

  const cacheManager = CacheManager.register({
    targetUrl: renderResult.finalUrl,
    html: renderResult.html,
    seoAnalysis: seoAnalysisResult,
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
  result.isCachedToR2 = r2Synced;
  result.isCachedToKV = kvSynced;
  if (!kvSynced || !r2Synced) {
    logger.error(
      `${INDENT}${INDENT}↳ ${path} - caching failed: kvSynced: ${kvSynced}, r2Synced: ${r2Synced}`,
    );
    return result;
  }
  logger.info(`${INDENT}${INDENT}↳ ${path} - caching completed`);
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
}): Promise<{
  countRendered: number;
  countKvSynced: number;
  countR2Synced: number;
  failedToRenderUrls: string[];
  failedToSyncUrls: string[];
}> {
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

  return {
    countRendered: pipelineResults.filter((result) => result.isRendered).length,
    countKvSynced: pipelineResults.filter((result) => result.isCachedToKV)
      .length,
    countR2Synced: pipelineResults.filter((result) => result.isCachedToR2)
      .length,
    failedToRenderUrls: pipelineResults
      .filter((result) => !result.isRendered)
      .map((result) => result.url),
    failedToSyncUrls: pipelineResults
      .filter((result) => !result.isCachedToR2 || !result.isCachedToKV)
      .map((result) => result.url),
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = getConfig();

  // STEP 1 : Prepare target URLs
  const { urlsToRender, sitemapUrl } = await prepareTargetUrls({ config });

  // STEP 2 : Launch browser
  const browser = await launchBrowser();

  // STEP 3 : Run the pipeline batches
  const {
    countRendered,
    countKvSynced,
    countR2Synced,
    failedToRenderUrls,
    failedToSyncUrls,
  } = await runPipelineBatches({
    concurrency: config.concurrency,
    browser,
    urlsToRender,
    config,
  });

  const completedAt = Date.now();

  // STEP 5 : Report result
  const domain = getDomain(urlsToRender[0]!);
  await reportResult({
    config,
    countRendered,
    countKvSynced,
    countR2Synced,
    failedToRenderUrls,
    failedToSyncUrls,
    domain: domain!,
    sitemapUrl,
    sitemapFilter: config.sitemapUpdatedWithin,
    startedAt,
    completedAt,
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
