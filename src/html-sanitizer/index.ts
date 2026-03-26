import { Node, NodeType, parse, type HTMLElement } from "node-html-parser";
import type { SanitizeOptions } from "./type";
import { detectSoft404 } from "./soft-404";
import * as beautifier from "js-beautify";

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
  const root = parse(html, { comment: true });

  // -------------------------------------------------------------------------
  // Step 0: Merge multiple <head> elements into one
  // -------------------------------------------------------------------------
  mergeHeadTags(root);

  // -------------------------------------------------------------------------
  // Step 1: Extract body text BEFORE any body modifications (needed for soft 404)
  // -------------------------------------------------------------------------
  const head = root.querySelector("head");
  const titleEl = head?.querySelector("title") ?? null;
  const titleText = titleEl?.textContent ?? undefined;
  const bodyText = extractBodyText(root);
  const wordCount = countWords(bodyText);

  const isSoft404 = detectSoft404({
    title: titleText,
    bodyText,
    wordCount,
  });

  let canonicalUrl: string | null = null;
  if (head) {
    // -------------------------------------------------------------------------
    // R1: Remove noindex meta tags
    // -------------------------------------------------------------------------
    removeNoindexTags(head, isSoft404);

    // -------------------------------------------------------------------------
    // R2: Deduplicate unique tags
    // -------------------------------------------------------------------------
    deduplicateTitles(head);
    for (const selector of UNIQUE_TAG_SELECTORS) {
      deduplicateBySelector(head, selector);
    }
    deduplicateOgProperties(head);
    deduplicateTwitterProperties(head);

    // -------------------------------------------------------------------------
    // Internal param cleaning (migrated from RenderEngine)
    // -------------------------------------------------------------------------
    cleanInternalParams(head);

    // -------------------------------------------------------------------------
    // R3: Fix canonical URL hostname
    // -------------------------------------------------------------------------
    canonicalUrl = fixCanonicalUrl(head, canonicalDomain, url);

    // -------------------------------------------------------------------------
    // R4: Sync og:url and twitter:url with corrected canonical
    // -------------------------------------------------------------------------
    if (canonicalUrl) {
      syncUrlMeta(head, canonicalUrl);
    }

    // -------------------------------------------------------------------------
    // R5: Fix <base href> hostname
    // -------------------------------------------------------------------------
    fixBaseTag(head, canonicalDomain);

    // -------------------------------------------------------------------------
    // R6: Ensure charset and viewport exist
    // -------------------------------------------------------------------------
    ensureCharset(head);
    ensureViewport(head);
  }

  // -------------------------------------------------------------------------
  // R7 + R10: Remove inline scripts (head + body)
  // -------------------------------------------------------------------------
  removeInlineScripts(root);

  // -------------------------------------------------------------------------
  // R8 + R11: Remove all <style> elements (head + body)
  // -------------------------------------------------------------------------
  removeStyleElements(root);

  // -------------------------------------------------------------------------
  // R9: Remove browser performance hint links
  // -------------------------------------------------------------------------
  removePerfHintLinks(root);

  // -------------------------------------------------------------------------
  // R15: Remove inline SVGs
  // -------------------------------------------------------------------------
  removeElements(root, "svg");

  // -------------------------------------------------------------------------
  // R16: Remove hidden elements
  // -------------------------------------------------------------------------
  removeHiddenElements(root);

  // -------------------------------------------------------------------------
  // R17: Remove <noscript> blocks
  // -------------------------------------------------------------------------
  removeElements(root, "noscript");

  // -------------------------------------------------------------------------
  // R12: Remove inline style attributes
  // -------------------------------------------------------------------------
  removeAttributes(root, "style");

  // -------------------------------------------------------------------------
  // R13: Remove class attributes
  // -------------------------------------------------------------------------
  removeAttributes(root, "class");

  // -------------------------------------------------------------------------
  // R14: Remove data-* attributes (except data-rh)
  // -------------------------------------------------------------------------
  removeDataAttributes(root);

  // -------------------------------------------------------------------------
  // R18: Remove HTML comments
  // -------------------------------------------------------------------------
  removeComments(root);

  // -------------------------------------------------------------------------
  // R20–R27: Inject missing OG/Twitter metadata
  // -------------------------------------------------------------------------
  injectMissingMetadata(root, canonicalUrl, canonicalDomain);

  if (head) {
    // -------------------------------------------------------------------------
    // Head tag reordering (migrated from RenderEngine)
    // -------------------------------------------------------------------------
    reorderHeadTags(head);
  }

  // -------------------------------------------------------------------------
  // Serialize
  // -------------------------------------------------------------------------
  const output = root.toString();

  // -------------------------------------------------------------------------
  // R28: Collapse excessive whitespace
  // -------------------------------------------------------------------------
  const collapsedOutput = collapseWhitespace(output);

  const finalRoot = parse(collapsedOutput);
  let finalOutput = finalRoot.toString();
  try {
    finalOutput = beautifier.html(finalOutput, { indent_size: 2 });
  } catch {
    // Ignore errors
  }

  return finalOutput;
}

// ---------------------------------------------------------------------------
// Implementation helpers
// ---------------------------------------------------------------------------

// -- Step 0 --

/**
 * Merge multiple <head> elements into one.
 *
 * SPA frameworks (React with react-helmet, Next.js, etc.) can produce HTML
 * with more than one <head>. We consolidate all children into the first
 * <head> and remove the duplicates so that every downstream step operates
 * on a single, unified <head>.
 */
function mergeHeadTags(root: HTMLElement): void {
  const heads = root.querySelectorAll("head");
  if (heads.length <= 1) return;

  const primary = heads[0]!;

  for (let i = 1; i < heads.length; i++) {
    const dup = heads[i]!;
    // Move every child node into the primary <head>
    for (const child of [...dup.childNodes]) {
      primary.appendChild(child);
    }
    // Remove the now-empty duplicate <head>
    dup.remove();
  }
}

/**
 * Extract plain text from body for soft 404 detection.
 * Strips scripts, styles, noscript, template blocks and all tags.
 */
function extractBodyText(root: HTMLElement): string {
  let content = root.querySelector("body")?.innerHTML ?? "";
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

function removeNoindexTags(head: HTMLElement, isSoft404: boolean): void {
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
    const elements = head.querySelectorAll(selector);
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

function deduplicateTitles(head: HTMLElement): void {
  const titles = head.querySelectorAll("title");
  if (titles.length <= 1) return;

  // Helmet-marked wins, otherwise last wins
  let winner: HTMLElement | null = null;
  for (const el of titles) {
    if (el.getAttribute("data-rh") === "true") {
      winner = el;
      break;
    }
  }
  if (!winner) {
    winner = titles[titles.length - 1]!;
  }

  // If the chosen winner has empty text, prefer the last candidate with text
  if (!winner.textContent?.trim()) {
    const reversedTitles = [...titles].reverse();
    for (const el of reversedTitles) {
      if (el.textContent?.trim()) {
        winner = el;
        break;
      }
    }
  }

  for (const el of titles) {
    if (el !== winner) el.remove();
  }
}

function deduplicateBySelector(head: HTMLElement, selector: string): void {
  const elements = head.querySelectorAll(selector);
  if (elements.length <= 1) return;

  // Helmet-marked wins, otherwise last wins
  let winner: HTMLElement | null = null;
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
function deduplicateOgProperties(head: HTMLElement): void {
  const ogMetas = head.querySelectorAll('meta[property^="og:"]');
  const groups = new Map<string, HTMLElement[]>();

  for (const el of ogMetas) {
    const prop = el.getAttribute("property")!;
    if (!groups.has(prop)) {
      groups.set(prop, []);
    }
    groups.get(prop)!.push(el);
  }

  for (const [, elements] of groups) {
    if (elements.length <= 1) continue;
    let winner: HTMLElement | null = null;
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
function deduplicateTwitterProperties(head: HTMLElement): void {
  const twitterMetas = head.querySelectorAll('meta[name^="twitter:"]');
  const groups = new Map<string, HTMLElement[]>();

  for (const el of twitterMetas) {
    const name = el.getAttribute("name")!;
    if (!groups.has(name)) {
      groups.set(name, []);
    }
    groups.get(name)!.push(el);
  }

  for (const [, elements] of groups) {
    if (elements.length <= 1) continue;
    let winner: HTMLElement | null = null;
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

function cleanInternalParams(head: HTMLElement): void {
  // Clean canonical href
  const canonical = head.querySelector('link[rel="canonical"]');
  if (canonical) {
    const href = canonical.getAttribute("href");
    if (href) {
      canonical.setAttribute("href", stripInternalParams(href));
    }
  }

  // Clean og:url
  const ogUrl = head.querySelector('meta[property="og:url"]');
  if (ogUrl) {
    const content = ogUrl.getAttribute("content");
    if (content) {
      ogUrl.setAttribute("content", stripInternalParams(content));
    }
  }

  // Clean twitter:url
  const twitterUrl = head.querySelector('meta[name="twitter:url"]');
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
  head: HTMLElement,
  canonicalDomain: string,
  pageUrl: string,
): string | null {
  const canonical = head.querySelector('link[rel="canonical"]') ?? null;

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

function syncUrlMeta(head: HTMLElement, canonicalUrl: string): void {
  const ogUrl = head.querySelector('meta[property="og:url"]');
  if (ogUrl) {
    ogUrl.setAttribute("content", canonicalUrl);
  }

  const twitterUrl = head.querySelector('meta[name="twitter:url"]');
  if (twitterUrl) {
    twitterUrl.setAttribute("content", canonicalUrl);
  }
}

// -- R5 --

function fixBaseTag(head: HTMLElement, canonicalDomain: string): void {
  const base = head.querySelector("base") ?? null;
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

function ensureCharset(head: HTMLElement): void {
  const existing = head.querySelector("meta[charset]");
  if (existing) return;

  // Also check for <meta http-equiv="Content-Type">
  const httpEquiv = head.querySelector('meta[http-equiv="Content-Type"]');
  if (httpEquiv) return;

  const meta = parse('<meta charset="utf-8">');
  head.insertAdjacentHTML("afterbegin", meta.toString());
}

function ensureViewport(head: HTMLElement): void {
  const existing = head.querySelector('meta[name="viewport"]');
  if (existing) return;

  head.insertAdjacentHTML(
    "afterbegin",
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
  );
}

// -- R7 + R10 --

function removeInlineScripts(root: HTMLElement): void {
  const scripts = root.querySelectorAll("script");
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

function removeStyleElements(root: HTMLElement): void {
  const styles = root.querySelectorAll("style");
  for (const style of styles) {
    style.remove();
  }
}

// -- R9 --

function removePerfHintLinks(root: HTMLElement): void {
  const links = root.querySelectorAll("link[rel]");
  for (const link of links) {
    const rel = link.getAttribute("rel")?.toLowerCase() ?? "";
    if (PERF_HINT_RELS.has(rel)) {
      link.remove();
    }
  }
}

// -- R15, R17 --

function removeElements(root: HTMLElement, tagName: string): void {
  const elements = root.querySelectorAll(tagName);
  for (const el of elements) {
    el.remove();
  }
}

// -- R16 --

function removeHiddenElements(root: HTMLElement): void {
  // Remove elements with hidden attribute
  const hiddenEls = root.querySelectorAll("[hidden]");
  for (const el of hiddenEls) {
    el.remove();
  }

  // Remove elements with aria-hidden="true"
  const ariaHiddenEls = root.querySelectorAll('[aria-hidden="true"]');
  for (const el of ariaHiddenEls) {
    el.remove();
  }
}

// -- R12, R13 --

function removeAttributes(root: HTMLElement, attrName: string): void {
  const elements = root.querySelectorAll(`[${attrName}]`);
  for (const el of elements) {
    el.removeAttribute(attrName);
  }
}

// -- R14 --

function removeDataAttributes(root: HTMLElement): void {
  const allElements = root.querySelectorAll("*");
  for (const el of allElements) {
    const attrsToRemove: string[] = [];
    for (const name of Object.keys(el.attributes)) {
      if (name.startsWith("data-") && name !== "data-rh") {
        attrsToRemove.push(name);
      }
    }
    for (const name of attrsToRemove) {
      el.removeAttribute(name);
    }
  }
}

// -- R18 --

/**
 * Recursively walk child nodes and remove comment nodes (nodeType === 8).
 */
function removeComments(root: HTMLElement): void {
  walkAndRemoveComments(root);
}

function walkAndRemoveComments(node: Node): void {
  const children = [...node.childNodes];
  for (const child of children) {
    if (child.nodeType === NodeType.COMMENT_NODE) {
      // Comment node
      child.remove();
    } else if (child.childNodes.length > 0) {
      walkAndRemoveComments(child);
    }
  }
}

// -- R20–R27 --

function injectMissingMetadata(
  root: HTMLElement,
  canonicalUrl: string | null,
  canonicalDomain: string,
): void {
  const head = root.querySelector("head");
  if (!head) return;

  // Gather existing values for derivation — strictly from <head>
  const title = head.querySelector("title")?.textContent ?? null;
  const description =
    head.querySelector('meta[name="description"]')?.getAttribute("content") ??
    null;
  const existingOgImage =
    head.querySelector('meta[property="og:image"]')?.getAttribute("content") ??
    null;

  // R20: og:url
  if (!head.querySelector('meta[property="og:url"]') && canonicalUrl) {
    appendMeta(head, "property", "og:url", canonicalUrl);
  }

  // R21: og:type
  if (!head.querySelector('meta[property="og:type"]')) {
    appendMeta(head, "property", "og:type", "website");
  }

  // R22: og:title
  const existingOgTitle = head.querySelector('meta[property="og:title"]');
  if (!existingOgTitle && title) {
    appendMeta(head, "property", "og:title", title);
  }

  // R23: og:description
  const existingOgDesc = head.querySelector('meta[property="og:description"]');
  if (!existingOgDesc && description) {
    appendMeta(head, "property", "og:description", description);
  }

  // R24: og:site_name
  if (!head.querySelector('meta[property="og:site_name"]')) {
    appendMeta(head, "property", "og:site_name", canonicalDomain);
  }

  // R25: og:locale
  if (!head.querySelector('meta[property="og:locale"]')) {
    const locale = deriveLocale(root);
    appendMeta(head, "property", "og:locale", locale);
  }

  // Now get the og:title and og:description for twitter fallback
  const ogTitleValue =
    head.querySelector('meta[property="og:title"]')?.getAttribute("content") ??
    null;
  const ogDescValue =
    head
      .querySelector('meta[property="og:description"]')
      ?.getAttribute("content") ?? null;

  // R26: twitter:card
  if (!head.querySelector('meta[name="twitter:card"]')) {
    const cardType = existingOgImage ? "summary_large_image" : "summary";
    appendMeta(head, "name", "twitter:card", cardType);
  }

  // R27: twitter:title
  if (!head.querySelector('meta[name="twitter:title"]') && ogTitleValue) {
    appendMeta(head, "name", "twitter:title", ogTitleValue);
  }

  // R27: twitter:description
  if (!head.querySelector('meta[name="twitter:description"]') && ogDescValue) {
    appendMeta(head, "name", "twitter:description", ogDescValue);
  }
}

function appendMeta(
  head: HTMLElement,
  attrType: "property" | "name",
  attrValue: string,
  content: string,
): void {
  head.appendChild(
    parse(`<meta ${attrType}="${attrValue}" content="${content}">`),
  );
}

/**
 * Default country mapping for language-only codes (e.g. "en" -> "en_US").
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

function deriveLocale(root: HTMLElement): string {
  const lang = root.querySelector("html")?.getAttribute("lang");
  if (!lang) return "en_US";

  const parts = lang.split(/[-_]/);
  if (parts.length === 1) {
    const code = parts[0]!.toLowerCase();
    // Use the known mapping, or fall back to code_CODE (works for fr->fr_FR, de->de_DE, etc.)
    return LANG_TO_DEFAULT_LOCALE[code] ?? `${code}_${code.toUpperCase()}`;
  }
  // "en-US" -> "en_US", "zh-CN" -> "zh_CN"
  return `${parts[0]!.toLowerCase()}_${parts[1]!.toUpperCase()}`;
}

// -- Head tag reordering (migrated from RenderEngine) --

function reorderHeadTags(head: HTMLElement): void {
  // Collect tags to hoist (in reverse priority order — we'll prepend each)
  const tagsToHoist: HTMLElement[] = [];

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

  // Capture outerHTML before removing (since remove() destroys them)
  const hoistedHtml = tagsToHoist.map((el) => el.outerHTML);

  // Remove all from their current positions
  for (const el of tagsToHoist) {
    el.remove();
  }

  // Build the combined hoisted block and insert once at the beginning of <head>.
  // Final order: charset -> viewport -> title -> data-rh -> rest
  // tagsToHoist is ordered: [data-rh..., title..., viewport..., charset...]
  // so reversing gives us: charset, viewport, title, data-rh (the desired order)
  const combinedHtml = hoistedHtml.reverse().join("");
  head.insertAdjacentHTML("afterbegin", combinedHtml);
}

// -- R28 --

function collapseWhitespace(html: string): string {
  // Remove trailing whitespace per line
  html = html.replace(/[ \t]+$/gm, "");

  // Collapse 3+ consecutive blank lines to a single blank line
  html = html.replace(/(\n\s*){3,}/g, "\n\n");

  return html;
}
