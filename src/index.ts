import { uniq } from "es-toolkit";
import normalizeUrl from "normalize-url";
import { getHostname } from "tldts";
import { loadConfig } from "./load-config.js";
import { logger } from "./logger.js";
import { RenderEngine } from "./render-engine.js";
import { SeoAnalyzer } from "./seo-analyzer/index.js";
import { SitemapParser } from "./sitemap-parser.js";

async function main() {
  const config = loadConfig();
  const urlsToRender = [...config.urlList];
  logger.info("Configuration loaded successfully:");

  // STEP 1 : Fetch and parse sitemap
  // Explicit sitemap url is optional
  // All other sitemap urls are generated from the URLs in the URL_LIST
  const targetSiteMapUrls = config.sitemapUrl ? [config.sitemapUrl] : [];
  urlsToRender.forEach((url) => {
    const hostname = getHostname(url);
    targetSiteMapUrls.push(`https://${hostname}/sitemap.xml`);
  });
  for (const sitemapUrl of targetSiteMapUrls) {
    const sitemapParser = SitemapParser.register({
      sitemapUrl,
      lastmodFilter: config.sitemapUpdatedWithin,
    });
    const parseResult = await sitemapParser.parseSitemap();
    urlsToRender.push(...parseResult);
  }

  // STEP 2 : Pre-render pages
  const normalizedUrls = uniq(urlsToRender.map((url) => normalizeUrl(url)));
  const renderer = RenderEngine.register({
    targetUrls: normalizedUrls,
    userAgent: config.userAgent,
    concurrency: config.concurrency,
  });
  const { successfulResults, failedResults } = await renderer.renderAll();
  logger.info(`Successfully rendered ${successfulResults.length} URLs`);
  if (failedResults.length > 0) {
    logger.info(`Failed to render ${failedResults.length} URLs`);
  }

  // STEP 3 : Extract SEO data
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

  // STEP 4 : Sync to Cloudflare R2 and KV

  // STEP 5 : Call webhook
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
