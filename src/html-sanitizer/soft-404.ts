/**
 * Shared soft 404 detection logic.
 * Used by both html-sanitizer (to decide whether to keep noindex tags)
 * and seo-analyzer (to flag soft 404 pages in analysis results).
 *
 * Semantics must stay identical to shared/html-parsing.ts in the
 * lovablehtml repo — both pipelines write R2 snapshots that the same
 * worker serves, and their verdicts must agree.
 */

const SOFT_404_TEXT_PATTERNS = [
  // Standalone 404 only: delimited by start/end of text, whitespace, a dash,
  // "!", or a period/comma not followed by a digit ("404", "404 Not found",
  // "404-Not found", "Error 404.", "404!", "got a 404, sorry") — never part
  // of a number like "$404.99", "1,404", or "404,000"
  /(?:^|[\s-])404(?:[\s!-]|[.,](?!\d)|$)/,
  /not found/i,
  /page unavailable/i,
  /does(?:n[’']t| not) exist/i,
  /could(?:n[’']t| not) find/i,
];

/** Check whether text contains common not-found wording. */
export function hasSoft404Wording(text: string): boolean {
  return SOFT_404_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Extract the numeric value of the `prerender-status-code` meta tag —
 * the tag users add to their 404 route to explicitly hint the status.
 */
export function extractStatusCodeHint(html: string): number | undefined {
  const match =
    html.match(
      /<meta[^>]+name=["']prerender-status-code["'][^>]+content=["']([^"']*)["']/i,
    ) ||
    html.match(
      /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']prerender-status-code["']/i,
    );
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  const code = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(code) ? code : undefined;
}

/**
 * Check whether any robots meta tag (`robots` or `googlebot`) carries a
 * noindex directive. Deliberately matches only the literal `noindex` —
 * `content="none"` is not recognized; the directive must be explicit.
 */
export function hasNoindexMeta(html: string): boolean {
  const patterns = [
    /<meta[^>]+name=["'](?:robots|googlebot)["'][^>]+content=["']([^"']*)["']/gi,
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["'](?:robots|googlebot)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const content = match[1];
      if (content !== undefined && /noindex/i.test(content)) return true;
    }
  }
  return false;
}

export type Soft404Reason = "status_code_hint" | "noindex_with_404_text";

export type Soft404Detection = {
  isSoft404: boolean;
  /** Status code to serve to crawlers when flagged (404, or 410 via hint). */
  statusCode?: number;
  reason?: Soft404Reason;
};

/**
 * Detect if a 200-status page is actually a soft 404.
 *
 * Precision beats recall here: a false positive serves a real page to
 * crawlers as a 404. So 404-like wording alone never flags a page — it must
 * be paired with a noindex robots meta, or the page must carry an explicit
 * `prerender-status-code` hint.
 */
export function detectSoft404(signals: {
  statusCode: number;
  title: string | undefined;
  bodyText: string;
  hasNoindex: boolean;
  statusCodeHint: number | undefined;
}): Soft404Detection {
  const { statusCode, title, bodyText, hasNoindex, statusCodeHint } = signals;

  if (statusCode !== 200) {
    return { isSoft404: false };
  }

  if (statusCodeHint === 404 || statusCodeHint === 410) {
    return {
      isSoft404: true,
      statusCode: statusCodeHint,
      reason: "status_code_hint",
    };
  }

  if (hasNoindex) {
    for (const text of [title ?? "", bodyText]) {
      if (hasSoft404Wording(text)) {
        return {
          isSoft404: true,
          statusCode: 404,
          reason: "noindex_with_404_text",
        };
      }
    }
  }

  return { isSoft404: false };
}

/**
 * Render-quality signal, separate from the soft-404 verdict: an empty or
 * structurally bare capture usually means the snapshot caught the SPA's
 * loading shell. Drives the pipeline's extended-stability retry; it never
 * changes the served status code. Real-but-minimal pages (login/signup
 * forms) have a title and an H1 and must not trigger a retry.
 */
export function looksLikeFailedRender({
  title,
  wordCount,
  h1Count,
}: {
  title: string | undefined;
  wordCount: number;
  h1Count: number;
}): boolean {
  if (wordCount === 0) return true;
  return wordCount < 20 && (!title?.trim() || h1Count === 0);
}
