import { DateTime } from "luxon";
import Sitemapper, {
  type SitemapperResponse,
  type SitemapperSiteData,
} from "sitemapper";
import { LastmodFilter } from "./load-config";
import { AppLogger } from "./logger";

const LASTMOD_FILTER_TO_DAYS = {
  [LastmodFilter.ONE_DAY]: 1,
  [LastmodFilter.THREE_DAYS]: 3,
  [LastmodFilter.SEVEN_DAYS]: 7,
  [LastmodFilter.THIRTY_DAYS]: 30,
};

export class SitemapParser {
  private readonly _logger: AppLogger;

  private constructor(
    private readonly _sitemapUrl: string,
    private readonly _lastmodFilter: LastmodFilter,
  ) {
    this._logger = AppLogger.register({ prefix: "sitemap-parser" });
  }

  static register({
    sitemapUrl,
    lastmodFilter,
  }: {
    sitemapUrl: string;
    lastmodFilter: LastmodFilter;
  }): SitemapParser {
    return new SitemapParser(sitemapUrl, lastmodFilter);
  }

  async parseSitemap(): Promise<string[]> {
    this._logger.info(
      `Parsing sitemap: ${this._sitemapUrl} with lastmod filter: ${this._lastmodFilter}`,
    );
    let lastmodToFilterBy: number = 0;
    if (this._lastmodFilter !== LastmodFilter.ALL) {
      lastmodToFilterBy = DateTime.now()
        .minus({ days: LASTMOD_FILTER_TO_DAYS[this._lastmodFilter] })
        .toMillis();
    }
    const sitemapper = new Sitemapper({
      url: this._sitemapUrl,
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
      this._logger.error(
        `Failed to fetch sitemap: ${errors.map((error) => `${error.type} on ${error.url}`).join(", ")}`,
      );
      return [];
    }
    this._logger.info(`Found ${sites.length} URLs in sitemap`);
    sites.forEach((site, index) => {
      this._logger.info(`  - ${index + 1}: ${site.loc}`);
    });
    return sites.map((site) => site.loc);
  }
}
