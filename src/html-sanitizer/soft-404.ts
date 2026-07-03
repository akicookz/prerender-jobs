/**
 * Shared soft 404 detection logic.
 * Used by both html-sanitizer (to decide whether to keep noindex tags)
 * and seo-analyzer (to flag soft 404 pages in analysis results).
 */

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

/**
 * Detect if a 200-status page is actually a soft 404.
 *
 * Heuristics:
 * 1. Title matches common 404 patterns (e.g. "Page Not Found", "Error 404")
 * 2. Very short content (<50 words) with 404-like text in the body
 * 3. Empty body (failed render)
 * 4. Extremely thin content (<20 words) that also lacks a title or H1
 */
export function detectSoft404({
  title,
  bodyText,
  wordCount,
  h1Count,
}: {
  title: string | undefined;
  bodyText: string;
  wordCount: number;
  h1Count: number;
}): boolean {
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

  // A completely empty body is a failed render regardless of head tags.
  if (wordCount === 0) {
    return true;
  }

  // Extremely thin content only counts as a soft 404 when the page also
  // lacks basic structure. Real-but-minimal pages (login/signup forms) have
  // a title and an H1 and must not be served to crawlers as 404s.
  if (wordCount < 20 && (!title?.trim() || h1Count === 0)) {
    return true;
  }

  return false;
}
