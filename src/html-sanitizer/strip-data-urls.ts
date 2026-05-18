import { randomBytes } from "node:crypto";

// Matches a single inline data URL with base64 payload. The base64 alphabet
// class has no nested quantifiers / alternation, so V8 handles arbitrarily
// long matches in linear time without recursion (unlike node-html-parser's
// kMarkupPattern, which is the whole reason we're doing this).
const DATA_URL_RE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

const DEFAULT_THRESHOLD_BYTES = 10_000;

export interface DataUrlExtraction {
  html: string;
  urlMap: Map<string, string>;
}

/**
 * Replace base64 data URLs over `threshold` bytes with short placeholder
 * tokens. Returns the rewritten HTML plus a map from token -> original URL
 * for later restoration via {@link restoreDataUrls}.
 *
 * Tokens use a per-call random suffix so they cannot collide with any
 * literal string already present in the document.
 */
export function extractOversizedDataUrls(
  html: string,
  threshold: number = DEFAULT_THRESHOLD_BYTES,
): DataUrlExtraction {
  const urlMap = new Map<string, string>();
  const token = randomBytes(8).toString("hex");
  let counter = 0;
  const stripped = html.replace(DATA_URL_RE, (match) => {
    if (match.length < threshold) return match;
    const key = `__OVERSIZED_DATA_URL_${token}_${counter++}__`;
    urlMap.set(key, match);
    return key;
  });
  return { html: stripped, urlMap };
}

/**
 * Replace placeholder tokens produced by {@link extractOversizedDataUrls}
 * with their original data URL values.
 */
export function restoreDataUrls(
  html: string,
  urlMap: Map<string, string>,
): string {
  if (urlMap.size === 0) return html;
  let result = html;
  for (const [key, original] of urlMap) {
    // split/join is safe regardless of regex metacharacters in `original`.
    result = result.split(key).join(original);
  }
  return result;
}
