import { getHostname } from "tldts";
import { loadConfig } from "./load-config.js";
import { logger } from "./logger.js";
import { RenderEngine } from "./render-engine.js";
import { parseSitemap } from "./sitemap-parser.js";
import { uniq } from "es-toolkit";

async function main() {
  const config = loadConfig();
  const urlsToPrerender = [...config.urlList];
  logger.info("Configuration loaded successfully:");

  // STEP 1 : Fetch and parse sitemap
  // sitemap url is optional,
  // if not provided, we will use the hostname of the first URL in the list to generate the sitemap url
  const urlsFromSitemap = await parseSitemap({
    sitemapUrl:
      config.sitemapUrl ||
      `https://${getHostname(config.urlList[0]!)}/sitemap.xml`,
    lastmodFilter: config.sitemapUpdatedWithin,
  });
  urlsToPrerender.push(...urlsFromSitemap);

  // STEP 2 : Pre-render pages
  const renderer = RenderEngine.register({
    targetUrls: uniq(urlsToPrerender),
    userAgent: config.userAgent,
  });
  const results = await renderer.renderAll();
  logger.info(`Successfully rendered ${results.length} URLs`);

  // STEP 3 : Extract SEO data

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
