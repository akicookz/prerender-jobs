// ============================================================================
// Types
// ============================================================================

export type OgTags = {
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogUrl?: string;
  ogType?: string;
  ogSiteName?: string;
  twitterCard?: string;
  twitterTitle?: string;
  twitterDescription?: string;
  twitterImage?: string;
  favicon?: string;
};

export type RobotsTxtResult = {
  userAgents: {
    name: string;
    rules: { type: "allow" | "disallow"; path: string }[];
    crawlDelay?: number;
  }[];
  sitemaps: string[];
  raw: string;
};

export type MetaTags = {
  title?: string;
  titleLength?: number;
  description?: string;
  descriptionLength?: number;
  canonical?: string;
  robotsMeta?: string;
  viewport?: string;
  charset?: string;
};

export type IndexableReason =
  | "noindex_meta"
  | "noindex_header"
  | "status_4xx"
  | "status_5xx";

export type Soft404Reason =
  | "title_indicates_404"
  | "thin_content_with_404_text"
  | "extremely_thin_content";

export type PageSeoAnalysis = {
  // Response data
  statusCode: number;

  // Indexability
  indexable: boolean;
  indexableReason?: IndexableReason;

  // Soft 404 detection
  isSoft404: boolean;
  soft404Reason?: Soft404Reason;

  // Title
  title?: string;
  titleLength?: number;
  titleStatus?: "ok" | "missing" | "too_short" | "too_long";

  // Meta description
  metaDescription?: string;
  metaDescLength?: number;
  metaDescStatus?: "ok" | "missing" | "too_short" | "too_long";

  // Canonical
  canonical?: string;
  canonicalMismatch?: boolean;

  // H1
  h1?: string;
  h1Count: number;
  h1Status?: "ok" | "missing" | "multiple";

  // Content
  wordCount: number;
  contentStatus?: "ok" | "thin" | "very_thin";

  // Social tags
  hasOgTags: boolean;
  hasTwitterTags: boolean;

  // Technical
  robotsMeta?: string;
  viewport?: string;
  hasViewport: boolean;
};
