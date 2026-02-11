import { JSDOM } from "jsdom";
import { DEFAULT_SEO_CONFIG } from "./config.js";
import type { MetaTags, OgTags, PageSeoAnalysis } from "./type.js";

export class SeoAnalyzer {
  private readonly _html: string;
  private readonly _url: string;
  private readonly _statusCode: number;
  private readonly _xRobotsTag: string | null;

  static register({
    html,
    url,
    statusCode,
    xRobotsTag,
  }: {
    html: string;
    url: string;
    statusCode: number;
    xRobotsTag: string | null;
  }): SeoAnalyzer {
    if (statusCode >= 300) {
      throw new Error(`Status code is not 200~299, got ${statusCode}`);
    }
    if (!url) {
      throw new Error("URL is required");
    }
    if (!html) {
      throw new Error("HTML is required");
    }
    return new SeoAnalyzer(html, url, statusCode, xRobotsTag);
  }
  private constructor(
    html: string,
    url: string,
    statusCode: number,
    xRobotsTag: string | null,
  ) {
    this._html = html;
    this._url = url;
    this._statusCode = statusCode;
    this._xRobotsTag = xRobotsTag;
  }

  analyze(): PageSeoAnalysis {
    const config = DEFAULT_SEO_CONFIG;

    const dom = new JSDOM(this._html);
    const document = dom.window.document;

    // Extract meta tags
    const metaTags = this.extractMetaTags({ document });
    const ogTags = this.extractOgTags({ document });
    const h1Tags = this.extractH1Tags({ document });

    // Extract body text and count words
    const bodyText = this.extractBodyText({ document });
    const wordCount = this.countWords({ text: bodyText });

    // -------------------------------------------------------------------------
    // Indexability
    // -------------------------------------------------------------------------
    const indexable = this.checkIndexability({
      robotsMeta: metaTags.robotsMeta,
    });

    // -------------------------------------------------------------------------
    // Soft 404 detection
    // -------------------------------------------------------------------------
    const isSoft404 = this.detectSoft404({
      title: metaTags.title,
      bodyText,
      wordCount,
    });

    const titleStatus = this.assessTitle({
      title: metaTags.title,
      titleLength: metaTags.titleLength ?? 0,
    });

    // -------------------------------------------------------------------------
    // Meta description analysis
    // -------------------------------------------------------------------------
    const metaDescStatus = this.assessMetaDescription({
      metaDescription: metaTags.description,
      metaDescriptionLength: metaTags.descriptionLength ?? 0,
    });

    // -------------------------------------------------------------------------
    // Canonical analysis - TODO: Implement
    // -------------------------------------------------------------------------
    const canonicalMismatch = false;
    // if (metaTags.canonical) {
    //   try {
    //     const canonicalUrl = new URL(metaTags.canonical);
    //     const currentUrl = new URL(url);
    //     // Check if canonical points to a different page
    //     canonicalMismatch =
    //       canonicalUrl.hostname !== currentUrl.hostname ||
    //       canonicalUrl.pathname !== currentUrl.pathname;
    //   } catch {
    //     // Invalid URL, treat as mismatch
    //     canonicalMismatch = true;
    //   }
    // }

    // -------------------------------------------------------------------------
    // H1 analysis
    // -------------------------------------------------------------------------
    let h1Status: PageSeoAnalysis["h1Status"];
    if (h1Tags.length === 0) {
      h1Status = "missing";
    } else if (h1Tags.length > 1) {
      h1Status = "multiple";
    } else {
      h1Status = "ok";
    }

    // -------------------------------------------------------------------------
    // Content depth analysis
    // -------------------------------------------------------------------------
    let contentStatus: PageSeoAnalysis["contentStatus"];
    if (wordCount < config.thresholds.content_words_min) {
      contentStatus = "very_thin";
    } else if (wordCount < config.thresholds.content_words_low) {
      contentStatus = "thin";
    } else {
      contentStatus = "ok";
    }

    // -------------------------------------------------------------------------
    // Build result
    // -------------------------------------------------------------------------
    return {
      statusCode: this._statusCode,
      indexable,
      isSoft404,

      title: metaTags.title,
      titleLength: metaTags.titleLength,
      titleStatus: this.assessTitle({
        title: metaTags.title,
        titleLength: metaTags.titleLength ?? 0,
      }),

      metaDescription: metaTags.description,
      metaDescLength: metaTags.descriptionLength,
      metaDescStatus: this.assessMetaDescription({
        metaDescription: metaTags.description,
        metaDescriptionLength: metaTags.descriptionLength ?? 0,
      }),

      canonical: this.assessCanonical({ canonical: metaTags.canonical }),

      h1: h1Tags[0],
      h1Count: h1Tags.length,
      h1Status: this.assessH1({ h1Tags }),

      wordCount,
      contentStatus,

      hasOgTags: this.hasEssentialOgTags(ogTags),
      hasTwitterTags: this.hasEssentialTwitterTags(ogTags),

      robotsMeta: metaTags.robotsMeta,
      viewport: metaTags.viewport,
      hasViewport: !!metaTags.viewport,
    };
  }

  private extractMetaTags({ document }: { document: Document }): MetaTags {
    const metaTags: MetaTags = {};
    // title
    const title = document.querySelector("title")?.textContent;
    if (title) {
      metaTags.title = title;
      metaTags.titleLength = title.length;
    }

    // description
    const description = document
      .querySelector("meta[name='description']")
      ?.getAttribute("content");
    if (description) {
      metaTags.description = description;
      metaTags.descriptionLength = description.length;
    }

    // canonical
    const canonical = document
      .querySelector("link[rel='canonical']")
      ?.getAttribute("href");
    if (canonical) {
      metaTags.canonical = canonical;
    }

    // robots meta
    const robotsMeta = document
      .querySelector("meta[name='robots']")
      ?.getAttribute("content");
    if (robotsMeta) {
      metaTags.robotsMeta = robotsMeta;
    }

    // viewport
    const viewport = document
      .querySelector("meta[name='viewport']")
      ?.getAttribute("content");
    if (viewport) {
      metaTags.viewport = viewport;
    }

    // charset
    const charset = document
      .querySelector("meta[charset]")
      ?.getAttribute("charset");
    if (charset) {
      metaTags.charset = charset;
    }

    return metaTags;
  }

  private extractOgTags({ document }: { document: Document }): OgTags {
    const ogTags: OgTags = {};
    // title
    const ogTitle = document
      .querySelector("meta[property='og:title']")
      ?.getAttribute("content");
    if (ogTitle) {
      ogTags.ogTitle = ogTitle;
    }

    // description
    const ogDescription = document
      .querySelector("meta[property='og:description']")
      ?.getAttribute("content");
    if (ogDescription) {
      ogTags.ogDescription = ogDescription;
    }

    // image
    const ogImage = document
      .querySelector("meta[property='og:image']")
      ?.getAttribute("content");
    if (ogImage) {
      ogTags.ogImage = ogImage;
    }

    // url
    const ogUrl = document
      .querySelector("meta[property='og:url']")
      ?.getAttribute("content");
    if (ogUrl) {
      ogTags.ogUrl = ogUrl;
    }

    // type
    const ogType = document
      .querySelector("meta[property='og:type']")
      ?.getAttribute("content");
    if (ogType) {
      ogTags.ogType = ogType;
    }

    // site name
    const ogSiteName = document
      .querySelector("meta[property='og:site_name']")
      ?.getAttribute("content");
    if (ogSiteName) {
      ogTags.ogSiteName = ogSiteName;
    }

    // twitter card
    const twitterCard = document
      .querySelector("meta[name='twitter:card']")
      ?.getAttribute("content");
    if (twitterCard) {
      ogTags.twitterCard = twitterCard;
    }

    // twitter title
    const twitterTitle = document
      .querySelector("meta[name='twitter:title']")
      ?.getAttribute("content");
    if (twitterTitle) {
      ogTags.twitterTitle = twitterTitle;
    }

    // twitter description
    const twitterDescription = document
      .querySelector("meta[name='twitter:description']")
      ?.getAttribute("content");
    if (twitterDescription) {
      ogTags.twitterDescription = twitterDescription;
    }

    // twitter image
    const twitterImage = document
      .querySelector("meta[name='twitter:image']")
      ?.getAttribute("content");
    if (twitterImage) {
      ogTags.twitterImage = twitterImage;
    }

    // favicon
    const favicon = (
      document.querySelector("link[rel='icon']") ||
      document.querySelector("link[rel='shortcut icon']")
    )?.getAttribute("href");
    if (favicon) {
      ogTags.favicon = favicon;
    }

    return ogTags;
  }

  private extractH1Tags({ document }: { document: Document }): string[] {
    return Array.from(document.querySelectorAll("h1")).map(
      (h1) => h1.textContent || "",
    );
  }

  private checkIndexability({
    robotsMeta,
  }: {
    robotsMeta: string | undefined;
  }): boolean {
    if (!robotsMeta && !this._xRobotsTag) {
      return true;
    }

    if (robotsMeta && robotsMeta.toLowerCase().includes("noindex")) {
      return false;
    }

    if (
      this._xRobotsTag &&
      this._xRobotsTag.toLowerCase().includes("noindex")
    ) {
      return false;
    }

    return true;
  }

  private hasEssentialOgTags(ogTags: OgTags): boolean {
    return !!(ogTags.ogTitle && ogTags.ogDescription && ogTags.ogImage);
  }

  private hasEssentialTwitterTags(ogTags: OgTags): boolean {
    return !!(ogTags.twitterCard && (ogTags.twitterTitle || ogTags.ogTitle));
  }

  /**
   * Detect if a 200-status page is actually a soft 404.
   */
  private detectSoft404({
    title,
    bodyText,
    wordCount,
  }: {
    title: string | undefined;
    bodyText: string;
    wordCount: number;
  }): boolean {
    const SOFT_404_TITLE_PATTERNS = [
      /not found/i,
      /page not found/i,
      /404/i,
      /error 404/i,
      /page unavailable/i,
      /doesn't exist/i,
      /does not exist/i,
      /couldn't find/i,
      /could not find/i,
    ];

    // Check title for 404-like patterns
    if (title) {
      for (const pattern of SOFT_404_TITLE_PATTERNS) {
        if (pattern.test(title)) {
          return true;
        }
      }
    }

    // Check for very short content with 404-like text
    if (wordCount < 50) {
      for (const pattern of SOFT_404_TITLE_PATTERNS) {
        if (pattern.test(bodyText)) {
          return true;
        }
      }
    }

    // Extremely thin content might indicate soft 404
    if (wordCount < 20) {
      return true;
    }

    return false;
  }

  /**
   * Extract text using DOM traversal
   */

  private extractBodyText({ document }: { document: Document }): string {
    let content = document.body.innerHTML;

    // Remove script/style/noscript/template blocks (robust to whitespace + missing closers)
    content = content
      .replace(
        /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
        " ",
      )
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*/gi, " ");

    // Remove HTML comments
    content = content.replace(/<!--[\s\S]*?-->/g, " ");

    // Remove all remaining HTML tags
    content = content.replace(/<[^>]+>/g, " ");

    // Decode common HTML entities
    content = content
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&#x2F;/gi, "/");

    // Normalize whitespace
    content = content.replace(/\s+/g, " ").trim();

    return content;
  }

  private countWords({ text }: { text: string }): number {
    return text.split(/\s+/).filter(Boolean).length;
  }

  private assessTitle({
    title,
    titleLength = 0,
  }: {
    title: string | undefined;
    titleLength: number;
  }): PageSeoAnalysis["titleStatus"] {
    if (!title) {
      return "missing";
    } else if (titleLength < DEFAULT_SEO_CONFIG.thresholds.title_min) {
      return "too_short";
    } else if (titleLength > DEFAULT_SEO_CONFIG.thresholds.title_max) {
      return "too_long";
    } else {
      return "ok";
    }
  }

  private assessMetaDescription({
    metaDescription,
    metaDescriptionLength = 0,
  }: {
    metaDescription: string | undefined;
    metaDescriptionLength: number;
  }): PageSeoAnalysis["metaDescStatus"] {
    if (!metaDescription) {
      return "missing";
    }
    if (metaDescription.length < DEFAULT_SEO_CONFIG.thresholds.meta_desc_min) {
      return "too_short";
    }
    if (metaDescription.length > DEFAULT_SEO_CONFIG.thresholds.meta_desc_max) {
      return "too_long";
    }
    return "ok";
  }

  private assessCanonical({
    canonical,
  }: {
    canonical: string | undefined;
  }): "ok" | "missing" | "mismatch" {
    if (!canonical) {
      return "missing";
    }
    try {
      const canonicalUrl = new URL(canonical);
      const currentUrl = new URL(this._url);
      // Check if canonical points to a different page
      return canonicalUrl.hostname !== currentUrl.hostname ||
        canonicalUrl.pathname !== currentUrl.pathname
        ? "mismatch"
        : "ok";
    } catch {
      // Invalid URL, treat as mismatch
      return "mismatch";
    }
  }

  private assessH1({
    h1Tags,
  }: {
    h1Tags: string[];
  }): "ok" | "missing" | "multiple" {
    if (h1Tags.length === 0) {
      return "missing";
    } else if (h1Tags.length > 1) {
      return "multiple";
    } else {
      return "ok";
    }
  }
}
