import { DateTime } from "luxon";
import Sitemapper, {
  type SitemapperResponse,
  type SitemapperSiteData,
} from "sitemapper";
import { LastmodFilter } from "./load-config.js";
import { logger } from "./logger.js";

const LASTMOD_FILTER_TO_DAYS = {
  [LastmodFilter.ONE_DAY]: 1,
  [LastmodFilter.THREE_DAYS]: 3,
  [LastmodFilter.SEVEN_DAYS]: 7,
  [LastmodFilter.THIRTY_DAYS]: 30,
};

export async function parseSitemap({
  sitemapUrl,
  lastmodFilter,
}: {
  sitemapUrl: string;
  lastmodFilter: LastmodFilter;
}): Promise<string[]> {
  logger.info(
    `Parsing sitemap: ${sitemapUrl} with lastmod filter: ${lastmodFilter}`,
  );
  let lastmodToFilterBy: number = 0;
  if (lastmodFilter !== LastmodFilter.ALL) {
    lastmodToFilterBy = DateTime.now()
      .minus({ days: LASTMOD_FILTER_TO_DAYS[lastmodFilter] })
      .toMillis();
  }
  const sitemapper = new Sitemapper({
    url: sitemapUrl,
    timeout: 10000,
    lastmod: lastmodToFilterBy,
    fields: {
      loc: true,
      lastmod: true,
    },
  });
  const { sites, errors } = (await sitemapper.fetch()) as unknown as Omit<
    SitemapperResponse,
    "sites"
  > & { sites: SitemapperSiteData[] };
  if (errors.length > 0) {
    throw new Error(
      `Failed to fetch sitemap: ${errors.map((error) => `${error.type} on ${error.url}`).join(", ")}`,
    );
  }
  return sites.map((site) => site.loc);
}
