import { JSDOM } from "jsdom";
import { detectSoft404 } from "./soft-404";
import type { SanitizeOptions } from "./type";

/** Internal query params injected by the prerender system that must be stripped */
const INTERNAL_PARAMS = ["to_html", "cache_invalidate"];

/** Link rel values that are browser performance hints with no value for bots/AI */
const PERF_HINT_RELS = new Set([
  "preload",
  "prefetch",
  "preconnect",
  "dns-prefetch",
  "modulepreload",
]);

/**
 * Non-OG/Twitter tag selectors that should be unique in a document.
 * OG and Twitter properties are discovered dynamically (see deduplicateOgTwitter).
 */
const UNIQUE_TAG_SELECTORS = [
  'meta[name="description"]',
  'meta[name="viewport"]',
  'link[rel="canonical"]',
];

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Sanitize pre-rendered HTML for SEO correctness, metadata completion,
 * and noise removal. Produces clean, content-rich HTML suitable for
 * search engine crawlers and LLM/AI consumers.
 */
export function sanitizeHtml({
  html,
  url,
  canonicalDomain,
}: SanitizeOptions): string {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  // -------------------------------------------------------------------------
  // Step 1: Extract body text BEFORE any body modifications (needed for soft 404)
  // -------------------------------------------------------------------------
  const titleEl = document.querySelector("title");
  const titleText = titleEl?.textContent ?? undefined;
  const bodyText = extractBodyText(document);
  const wordCount = countWords(bodyText);

  // -------------------------------------------------------------------------
  // R1: Remove noindex meta tags
  // -------------------------------------------------------------------------
  const isSoft404 = detectSoft404({
    title: titleText,
    bodyText,
    wordCount,
  });
  removeNoindexTags(document, isSoft404);

  // -------------------------------------------------------------------------
  // R2: Deduplicate unique tags
  // -------------------------------------------------------------------------
  deduplicateTitles(document);
  for (const selector of UNIQUE_TAG_SELECTORS) {
    deduplicateBySelector(document, selector);
  }
  deduplicateOgProperties(document);
  deduplicateTwitterProperties(document);

  // -------------------------------------------------------------------------
  // Internal param cleaning (migrated from RenderEngine)
  // -------------------------------------------------------------------------
  cleanInternalParams(document);

  // -------------------------------------------------------------------------
  // R3: Fix canonical URL hostname
  // -------------------------------------------------------------------------
  const canonicalUrl = fixCanonicalUrl(document, canonicalDomain, url);

  // -------------------------------------------------------------------------
  // R4: Sync og:url and twitter:url with corrected canonical
  // -------------------------------------------------------------------------
  if (canonicalUrl) {
    syncUrlMeta(document, canonicalUrl);
  }

  // -------------------------------------------------------------------------
  // R5: Fix <base href> hostname
  // -------------------------------------------------------------------------
  fixBaseTag(document, canonicalDomain);

  // -------------------------------------------------------------------------
  // R6: Ensure charset and viewport exist
  // -------------------------------------------------------------------------
  ensureCharset(document);
  ensureViewport(document);

  // -------------------------------------------------------------------------
  // R7 + R10: Remove inline scripts (head + body)
  // -------------------------------------------------------------------------
  removeInlineScripts(document);

  // -------------------------------------------------------------------------
  // R8 + R11: Remove all <style> elements (head + body)
  // -------------------------------------------------------------------------
  removeStyleElements(document);

  // -------------------------------------------------------------------------
  // R9: Remove browser performance hint links
  // -------------------------------------------------------------------------
  removePerfHintLinks(document);

  // -------------------------------------------------------------------------
  // R15: Remove inline SVGs
  // -------------------------------------------------------------------------
  removeElements(document, "svg");

  // -------------------------------------------------------------------------
  // R16: Remove hidden elements
  // -------------------------------------------------------------------------
  removeHiddenElements(document);

  // -------------------------------------------------------------------------
  // R17: Remove <noscript> blocks
  // -------------------------------------------------------------------------
  removeElements(document, "noscript");

  // -------------------------------------------------------------------------
  // R12: Remove inline style attributes
  // -------------------------------------------------------------------------
  removeAttributes(document, "style");

  // -------------------------------------------------------------------------
  // R13: Remove class attributes
  // -------------------------------------------------------------------------
  removeAttributes(document, "class");

  // -------------------------------------------------------------------------
  // R14: Remove data-* attributes (except data-rh)
  // -------------------------------------------------------------------------
  removeDataAttributes(document);

  // -------------------------------------------------------------------------
  // R18: Remove HTML comments
  // -------------------------------------------------------------------------
  removeComments(document);

  // -------------------------------------------------------------------------
  // R20–R27: Inject missing OG/Twitter metadata
  // -------------------------------------------------------------------------
  injectMissingMetadata(document, canonicalUrl, canonicalDomain);

  // -------------------------------------------------------------------------
  // Head tag reordering (migrated from RenderEngine)
  // -------------------------------------------------------------------------
  reorderHeadTags(document);

  // -------------------------------------------------------------------------
  // Serialize
  // -------------------------------------------------------------------------
  let output = dom.serialize();

  // -------------------------------------------------------------------------
  // R28: Collapse excessive whitespace
  // -------------------------------------------------------------------------
  output = collapseWhitespace(output);

  return output;
}

// ---------------------------------------------------------------------------
// Implementation helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text from body for soft 404 detection.
 * Strips scripts, styles, noscript, template blocks and all tags.
 */
function extractBodyText(document: Document): string {
  let content = document.body?.innerHTML ?? "";
  // Remove script/style/noscript/template blocks
  content = content.replace(
    /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    " ",
  );
  // Remove all HTML tags
  content = content.replace(/<[^>]+>/g, " ");
  // Decode common entities
  content = content
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/");
  // Normalize whitespace
  content = content.replace(/\s+/g, " ").trim();
  return content;
}

/** Count words in a text string */
function countWords(text: string): number {
  if (!text.trim()) return 0;
  return text.trim().split(/\s+/).length;
}

// -- R1 --

function removeNoindexTags(document: Document, isSoft404: boolean): void {
  const selectors = [
    'meta[name="robots"]',
    'meta[name="googlebot"]',
    // Case-insensitive fallbacks
    'meta[name="Robots"]',
    'meta[name="ROBOTS"]',
    'meta[name="Googlebot"]',
    'meta[name="GOOGLEBOT"]',
  ];

  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      const content = el.getAttribute("content") ?? "";
      if (!/noindex/i.test(content)) continue;

      // Exception: keep if explicitly set by app via react-helmet
      if (el.getAttribute("data-rh") === "true") continue;

      // Exception: keep if page is detected as soft 404
      if (isSoft404) continue;

      el.remove();
    }
  }
}

// -- R2 --

function deduplicateTitles(document: Document): void {
  const titles = document.querySelectorAll("title");
  if (titles.length <= 1) return;

  // Helmet-marked wins, otherwise last wins
  let winner: Element | null = null;
  for (const el of titles) {
    if (el.getAttribute("data-rh") === "true") {
      winner = el;
      break;
    }
  }
  if (!winner) {
    winner = titles[titles.length - 1]!;
  }

  for (const el of titles) {
    if (el !== winner) el.remove();
  }
}

function deduplicateBySelector(document: Document, selector: string): void {
  const elements = document.querySelectorAll(selector);
  if (elements.length <= 1) return;

  // Helmet-marked wins, otherwise last wins
  let winner: Element | null = null;
  for (const el of elements) {
    if (el.getAttribute("data-rh") === "true") {
      winner = el;
      break;
    }
  }
  if (!winner) {
    winner = elements[elements.length - 1]!;
  }

  for (const el of elements) {
    if (el !== winner) el.remove();
  }
}

/**
 * Dynamically discover all <meta property="og:*"> tags and deduplicate
 * each unique property value (og:title, og:image, og:image:alt, etc.).
 */
function deduplicateOgProperties(document: Document): void {
  const ogMetas = document.querySelectorAll('meta[property^="og:"]');
  const groups = new Map<string, Element[]>();

  for (const el of ogMetas) {
    const prop = el.getAttribute("property")!;
    if (!groups.has(prop)) {
      groups.set(prop, []);
    }
    groups.get(prop)!.push(el);
  }

  for (const [, elements] of groups) {
    if (elements.length <= 1) continue;
    let winner: Element | null = null;
    for (const el of elements) {
      if (el.getAttribute("data-rh") === "true") {
        winner = el;
        break;
      }
    }
    if (!winner) {
      winner = elements[elements.length - 1]!;
    }
    for (const el of elements) {
      if (el !== winner) el.remove();
    }
  }
}

/**
 * Dynamically discover all <meta name="twitter:*"> tags and deduplicate
 * each unique name value (twitter:card, twitter:image, twitter:site, etc.).
 */
function deduplicateTwitterProperties(document: Document): void {
  const twitterMetas = document.querySelectorAll('meta[name^="twitter:"]');
  const groups = new Map<string, Element[]>();

  for (const el of twitterMetas) {
    const name = el.getAttribute("name")!;
    if (!groups.has(name)) {
      groups.set(name, []);
    }
    groups.get(name)!.push(el);
  }

  for (const [, elements] of groups) {
    if (elements.length <= 1) continue;
    let winner: Element | null = null;
    for (const el of elements) {
      if (el.getAttribute("data-rh") === "true") {
        winner = el;
        break;
      }
    }
    if (!winner) {
      winner = elements[elements.length - 1]!;
    }
    for (const el of elements) {
      if (el !== winner) el.remove();
    }
  }
}

// -- Internal param cleaning --

function cleanInternalParams(document: Document): void {
  // Clean canonical href
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical) {
    const href = canonical.getAttribute("href");
    if (href) {
      canonical.setAttribute("href", stripInternalParams(href));
    }
  }

  // Clean og:url
  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) {
    const content = ogUrl.getAttribute("content");
    if (content) {
      ogUrl.setAttribute("content", stripInternalParams(content));
    }
  }

  // Clean twitter:url
  const twitterUrl = document.querySelector('meta[name="twitter:url"]');
  if (twitterUrl) {
    const content = twitterUrl.getAttribute("content");
    if (content) {
      twitterUrl.setAttribute("content", stripInternalParams(content));
    }
  }
}

function stripInternalParams(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    let modified = false;
    for (const param of INTERNAL_PARAMS) {
      if (url.searchParams.has(param)) {
        url.searchParams.delete(param);
        modified = true;
      }
    }
    return modified ? url.toString() : urlStr;
  } catch {
    return urlStr;
  }
}

// -- R3 --

function fixCanonicalUrl(
  document: Document,
  canonicalDomain: string,
  pageUrl: string,
): string | null {
  const canonical = document.querySelector('link[rel="canonical"]');

  if (!canonical) {
    // No <link rel="canonical"> exists. Derive the canonical URL from the
    // page URL + canonical domain so downstream injections (og:url etc.) work.
    try {
      const url = new URL(pageUrl);
      url.protocol = "https:";
      url.hostname = canonicalDomain;
      return url.toString();
    } catch {
      return null;
    }
  }

  const href = canonical.getAttribute("href");
  if (!href) return null;

  try {
    const url = new URL(href);
    url.protocol = "https:";
    url.hostname = canonicalDomain;
    // Reconstruct preserving path, query, fragment
    const newHref = url.toString();
    canonical.setAttribute("href", newHref);
    return newHref;
  } catch {
    return null;
  }
}

// -- R4 --

function syncUrlMeta(document: Document, canonicalUrl: string): void {
  const ogUrl = document.querySelector('meta[property="og:url"]');
  if (ogUrl) {
    ogUrl.setAttribute("content", canonicalUrl);
  }

  const twitterUrl = document.querySelector('meta[name="twitter:url"]');
  if (twitterUrl) {
    twitterUrl.setAttribute("content", canonicalUrl);
  }
}

// -- R5 --

function fixBaseTag(document: Document, canonicalDomain: string): void {
  const base = document.querySelector("base");
  if (!base) return;

  const href = base.getAttribute("href");
  if (!href) return;

  try {
    const url = new URL(href);
    url.protocol = "https:";
    url.hostname = canonicalDomain;
    base.setAttribute("href", url.toString());
  } catch {
    // Invalid URL, leave as-is
  }
}

// -- R6 --

function ensureCharset(document: Document): void {
  const existing = document.querySelector("meta[charset]");
  if (existing) return;

  // Also check for <meta http-equiv="Content-Type">
  const httpEquiv = document.querySelector('meta[http-equiv="Content-Type"]');
  if (httpEquiv) return;

  const meta = document.createElement("meta");
  meta.setAttribute("charset", "utf-8");
  document.head.prepend(meta);
}

function ensureViewport(document: Document): void {
  const existing = document.querySelector('meta[name="viewport"]');
  if (existing) return;

  const meta = document.createElement("meta");
  meta.setAttribute("name", "viewport");
  meta.setAttribute("content", "width=device-width, initial-scale=1");
  document.head.prepend(meta);
}

// -- R7 + R10 --

function removeInlineScripts(document: Document): void {
  const scripts = document.querySelectorAll("script");
  for (const script of scripts) {
    // Keep external scripts (have src attribute)
    if (script.hasAttribute("src")) continue;

    // Keep JSON-LD structured data
    const type = script.getAttribute("type")?.toLowerCase();
    if (type === "application/ld+json") continue;

    script.remove();
  }
}

// -- R8 + R11 --

function removeStyleElements(document: Document): void {
  const styles = document.querySelectorAll("style");
  for (const style of styles) {
    style.remove();
  }
}

// -- R9 --

function removePerfHintLinks(document: Document): void {
  const links = document.querySelectorAll("link[rel]");
  for (const link of links) {
    const rel = link.getAttribute("rel")?.toLowerCase() ?? "";
    if (PERF_HINT_RELS.has(rel)) {
      link.remove();
    }
  }
}

// -- R15, R17 --

function removeElements(document: Document, tagName: string): void {
  const elements = document.querySelectorAll(tagName);
  for (const el of elements) {
    el.remove();
  }
}

// -- R16 --

function removeHiddenElements(document: Document): void {
  // Remove elements with hidden attribute
  const hiddenEls = document.querySelectorAll("[hidden]");
  for (const el of hiddenEls) {
    el.remove();
  }

  // Remove elements with aria-hidden="true"
  const ariaHiddenEls = document.querySelectorAll('[aria-hidden="true"]');
  for (const el of ariaHiddenEls) {
    el.remove();
  }
}

// -- R12, R13 --

function removeAttributes(document: Document, attrName: string): void {
  const elements = document.querySelectorAll(`[${attrName}]`);
  for (const el of elements) {
    el.removeAttribute(attrName);
  }
}

// -- R14 --

function removeDataAttributes(document: Document): void {
  const allElements = document.querySelectorAll("*");
  for (const el of allElements) {
    const attrsToRemove: string[] = [];
    for (const attr of el.attributes) {
      if (attr.name.startsWith("data-") && attr.name !== "data-rh") {
        attrsToRemove.push(attr.name);
      }
    }
    for (const attrName of attrsToRemove) {
      el.removeAttribute(attrName);
    }
  }
}

// -- R18 --

function removeComments(document: Document): void {
  const walker = document.createTreeWalker(
    document.documentElement,
    128, // NodeFilter.SHOW_COMMENT
    null,
  );

  const comments: Comment[] = [];
  let node: Comment | null;
  while ((node = walker.nextNode() as Comment | null)) {
    comments.push(node);
  }
  for (const comment of comments) {
    comment.remove();
  }
}

// -- R20–R27 --

function injectMissingMetadata(
  document: Document,
  canonicalUrl: string | null,
  canonicalDomain: string,
): void {
  const head = document.head;

  // Gather existing values for derivation
  const title = document.querySelector("title")?.textContent ?? null;
  const description =
    document
      .querySelector('meta[name="description"]')
      ?.getAttribute("content") ?? null;
  const existingOgImage =
    document
      .querySelector('meta[property="og:image"]')
      ?.getAttribute("content") ?? null;

  // R20: og:url
  if (!document.querySelector('meta[property="og:url"]') && canonicalUrl) {
    appendMeta(head, "property", "og:url", canonicalUrl);
  }

  // R21: og:type
  if (!document.querySelector('meta[property="og:type"]')) {
    appendMeta(head, "property", "og:type", "website");
  }

  // R22: og:title
  const existingOgTitle = document.querySelector('meta[property="og:title"]');
  if (!existingOgTitle && title) {
    appendMeta(head, "property", "og:title", title);
  }

  // R23: og:description
  const existingOgDesc = document.querySelector(
    'meta[property="og:description"]',
  );
  if (!existingOgDesc && description) {
    appendMeta(head, "property", "og:description", description);
  }

  // R24: og:site_name
  if (!document.querySelector('meta[property="og:site_name"]')) {
    appendMeta(head, "property", "og:site_name", canonicalDomain);
  }

  // R25: og:locale
  if (!document.querySelector('meta[property="og:locale"]')) {
    const locale = deriveLocale(document);
    appendMeta(head, "property", "og:locale", locale);
  }

  // Now get the og:title and og:description for twitter fallback
  const ogTitleValue =
    document
      .querySelector('meta[property="og:title"]')
      ?.getAttribute("content") ?? null;
  const ogDescValue =
    document
      .querySelector('meta[property="og:description"]')
      ?.getAttribute("content") ?? null;

  // R26: twitter:card
  if (!document.querySelector('meta[name="twitter:card"]')) {
    const cardType = existingOgImage ? "summary_large_image" : "summary";
    appendMeta(head, "name", "twitter:card", cardType);
  }

  // R27: twitter:title
  if (!document.querySelector('meta[name="twitter:title"]') && ogTitleValue) {
    appendMeta(head, "name", "twitter:title", ogTitleValue);
  }

  // R27: twitter:description
  if (
    !document.querySelector('meta[name="twitter:description"]') &&
    ogDescValue
  ) {
    appendMeta(head, "name", "twitter:description", ogDescValue);
  }
}

function appendMeta(
  head: HTMLHeadElement,
  attrType: "property" | "name",
  attrValue: string,
  content: string,
): void {
  const meta = head.ownerDocument.createElement("meta");
  meta.setAttribute(attrType, attrValue);
  meta.setAttribute("content", content);
  head.appendChild(meta);
}

/**
 * Default country mapping for language-only codes (e.g. "en" → "en_US").
 * Covers the most common languages where the "obvious" country isn't
 * just the language code uppercased.
 */
const LANG_TO_DEFAULT_LOCALE: Record<string, string> = {
  en: "en_US",
  ja: "ja_JP",
  ko: "ko_KR",
  zh: "zh_CN",
  ar: "ar_SA",
  hi: "hi_IN",
  bn: "bn_BD",
  ur: "ur_PK",
  fa: "fa_IR",
  he: "he_IL",
  vi: "vi_VN",
  ms: "ms_MY",
  ta: "ta_IN",
  te: "te_IN",
  sv: "sv_SE",
  da: "da_DK",
  nb: "nb_NO",
  nn: "nn_NO",
  uk: "uk_UA",
  el: "el_GR",
  cs: "cs_CZ",
  sl: "sl_SI",
  et: "et_EE",
  ka: "ka_GE",
  sq: "sq_AL",
  sr: "sr_RS",
  bs: "bs_BA",
  hr: "hr_HR",
  ga: "ga_IE",
  cy: "cy_GB",
};

function deriveLocale(document: Document): string {
  const lang = document.documentElement.getAttribute("lang");
  if (!lang) return "en_US";

  const parts = lang.split(/[-_]/);
  if (parts.length === 1) {
    const code = parts[0]!.toLowerCase();
    // Use the known mapping, or fall back to code_CODE (works for fr→fr_FR, de→de_DE, etc.)
    return LANG_TO_DEFAULT_LOCALE[code] ?? `${code}_${code.toUpperCase()}`;
  }
  // "en-US" -> "en_US", "zh-CN" -> "zh_CN"
  return `${parts[0]!.toLowerCase()}_${parts[1]!.toUpperCase()}`;
}

// -- Head tag reordering (migrated from RenderEngine) --

function reorderHeadTags(document: Document): void {
  const head = document.head;
  if (!head) return;

  // Collect tags to hoist (in reverse priority order — we'll prepend each)
  const tagsToHoist: Element[] = [];

  // 4. data-rh="true" tags (lowest priority among hoisted)
  const rhTags = head.querySelectorAll("[data-rh]");
  for (const el of rhTags) {
    tagsToHoist.push(el);
  }

  // 3. <title>
  const titles = head.querySelectorAll("title");
  for (const el of titles) {
    // Don't double-add if it also has data-rh
    if (!el.hasAttribute("data-rh")) {
      tagsToHoist.push(el);
    }
  }

  // 2. <meta name="viewport">
  const viewports = head.querySelectorAll('meta[name="viewport"]');
  for (const el of viewports) {
    if (!el.hasAttribute("data-rh")) {
      tagsToHoist.push(el);
    }
  }

  // 1. <meta charset> (highest priority)
  const charsets = head.querySelectorAll("meta[charset]");
  for (const el of charsets) {
    if (!el.hasAttribute("data-rh")) {
      tagsToHoist.push(el);
    }
  }

  if (tagsToHoist.length === 0) return;

  // Remove all from their current positions
  for (const el of tagsToHoist) {
    el.remove();
  }

  // Insert in reverse order at the beginning of <head> so final order is:
  // charset -> viewport -> title -> data-rh -> rest
  const firstChild = head.firstChild;
  for (let i = tagsToHoist.length - 1; i >= 0; i--) {
    if (firstChild) {
      head.insertBefore(tagsToHoist[i]!, firstChild);
    } else {
      head.appendChild(tagsToHoist[i]!);
    }
  }
}

// -- R28 --

function collapseWhitespace(html: string): string {
  // Remove trailing whitespace per line
  html = html.replace(/[ \t]+$/gm, "");

  // Collapse 3+ consecutive blank lines to a single blank line
  html = html.replace(/(\n\s*){3,}/g, "\n\n");

  return html;
}
