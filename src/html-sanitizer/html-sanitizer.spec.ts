import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CANONICAL_DOMAIN = "example.com";
const BASE_URL = "https://example.com/page";

/** Wrap content in a minimal HTML document */
function doc({
  head = "",
  body = "",
  htmlAttrs = "",
}: {
  head?: string;
  body?: string;
  htmlAttrs?: string;
} = {}): string {
  return `<!DOCTYPE html><html${htmlAttrs ? " " + htmlAttrs : ""}><head>${head}</head><body>${body}</body></html>`;
}

/** Shorthand to sanitize with defaults */
function sanitize(
  html: string,
  {
    url = BASE_URL,
    canonicalDomain = CANONICAL_DOMAIN,
  }: { url?: string; canonicalDomain?: string } = {},
): string {
  return sanitizeHtml({ html, url, canonicalDomain });
}

/** Generate body with approximately n words */
function wordsBody(n: number): string {
  return `<p>${Array.from({ length: n }, (_, i) => `word${i}`).join(" ")}</p>`;
}

// ---------------------------------------------------------------------------
// Step 0 — Merge multiple <head> elements
// ---------------------------------------------------------------------------
describe("Step 0: merge multiple <head> tags", () => {
  it("merges two <head> elements into one", () => {
    const html = `<!DOCTYPE html><html><head><title>Hello</title></head><head><meta name="description" content="desc"></head><body><p>content</p></body></html>`;
    const result = sanitize(html);
    expect(result.match(/<head>/g)).toHaveLength(1);
    expect(result.match(/<\/head>/g)).toHaveLength(1);
    expect(result).toContain("<title>");
    expect(result).toContain('content="desc"');
  });

  it("merges three <head> elements into one", () => {
    const html = `<!DOCTYPE html><html><head><title>Title</title></head><head><meta name="description" content="desc"></head><head><link rel="canonical" href="https://example.com/page"></head><body><p>content</p></body></html>`;
    const result = sanitize(html);
    expect(result.match(/<head>/g)).toHaveLength(1);
    expect(result).toContain("<title>");
    expect(result).toContain('content="desc"');
    expect(result).toContain('rel="canonical"');
  });

  it("preserves children from all heads after merge", () => {
    const html = `<!DOCTYPE html><html><head><meta property="og:title" content="OG Title"></head><head><meta property="og:description" content="OG Desc"></head><body><p>content</p></body></html>`;
    const result = sanitize(html);
    expect(result).toContain('content="OG Title"');
    expect(result).toContain('content="OG Desc"');
  });

  it("deduplicates titles across merged heads", () => {
    const html = `<!DOCTYPE html><html><head><title>First</title></head><head><title>Second</title></head><body><p>content</p></body></html>`;
    const result = sanitize(html);
    // After merge + deduplication, only one <title> should remain
    expect(result.match(/<title>/g)).toHaveLength(1);
    // Last wins (the deduplication rule)
    expect(result).toContain("Second");
  });

  it("does not affect documents with a single <head>", () => {
    const html = doc({
      head: '<title>Only One</title><meta name="description" content="desc">',
      body: "<p>content</p>",
    });
    const result = sanitize(html);
    expect(result.match(/<head>/g)).toHaveLength(1);
    expect(result).toContain("Only One");
    expect(result).toContain('content="desc"');
  });

  it("injects metadata into the merged head correctly", () => {
    // Second head has a title but no og:title — injection should still work
    const html = `<!DOCTYPE html><html lang="en"><head></head><head><title>My Page</title></head><body><p>content</p></body></html>`;
    const result = sanitize(html);
    expect(result.match(/<head>/g)).toHaveLength(1);
    expect(result).toContain('property="og:title" content="My Page"');
  });
});

// ---------------------------------------------------------------------------
// R1 — Remove noindex tags
// ---------------------------------------------------------------------------
describe("R1: noindex removal", () => {
  it("strips <meta name='robots' content='noindex'>", () => {
    const html = doc({
      head: `<title>Hello</title><meta name="robots" content="noindex">`,
      body: wordsBody(100),
    });
    const result = sanitize(html);
    expect(result).not.toContain('content="noindex"');
  });

  it("strips <meta name='googlebot' content='noindex, nofollow'>", () => {
    const html = doc({
      head: `<title>Hello</title><meta name="googlebot" content="noindex, nofollow">`,
      body: wordsBody(100),
    });
    const result = sanitize(html);
    expect(result).not.toContain("googlebot");
  });

  it("strips noindex with combined directives like 'noindex, follow'", () => {
    const html = doc({
      head: `<title>Hello</title><meta name="robots" content="noindex, follow">`,
      body: wordsBody(100),
    });
    const result = sanitize(html);
    expect(result).not.toContain("noindex");
  });

  it("preserves noindex with data-rh='true'", () => {
    const html = doc({
      head: `<title>Hello</title><meta name="robots" content="noindex" data-rh="true">`,
      body: wordsBody(100),
    });
    const result = sanitize(html);
    expect(result).toContain("noindex");
  });

  it("preserves noindex when page title contains '404' (soft 404)", () => {
    const html = doc({
      head: `<title>404 - Page Not Found</title><meta name="robots" content="noindex">`,
      body: wordsBody(100),
    });
    const result = sanitize(html);
    expect(result).toContain("noindex");
  });

  it("preserves noindex when page has fewer than 20 words (thin content soft 404)", () => {
    const html = doc({
      head: `<title>Some Page</title><meta name="robots" content="noindex">`,
      body: wordsBody(10),
    });
    const result = sanitize(html);
    expect(result).toContain("noindex");
  });
});

// ---------------------------------------------------------------------------
// R2 — Deduplicate meta tags
// ---------------------------------------------------------------------------
describe("R2: meta deduplication", () => {
  it("deduplicates <title>, keeping the last one", () => {
    const html = doc({
      head: `<title>First</title><title>Second</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("Second");
    // Should only have one <title>
    const matches = result.match(/<title>/g);
    expect(matches).toHaveLength(1);
  });

  it("deduplicates <meta name='description'>, keeping the last one", () => {
    const html = doc({
      head: `<meta name="description" content="first"><meta name="description" content="second">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('content="second"');
    const matches = result.match(/name="description"/g);
    expect(matches).toHaveLength(1);
  });

  it("deduplicates <link rel='canonical'>, keeping the last one", () => {
    const html = doc({
      head: `<link rel="canonical" href="https://example.com/a"><link rel="canonical" href="https://example.com/page">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    const matches = result.match(/rel="canonical"/g);
    expect(matches).toHaveLength(1);
  });

  it("deduplicates <meta name='viewport'>, keeping the last one", () => {
    const html = doc({
      head: `<meta name="viewport" content="width=100"><meta name="viewport" content="width=device-width">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("width=device-width");
    const matches = result.match(/name="viewport"/g);
    expect(matches).toHaveLength(1);
  });

  it("deduplicates og:title — helmet-marked (data-rh) wins over unmarked", () => {
    const html = doc({
      head: `<meta property="og:title" content="Helmet Title" data-rh="true"><meta property="og:title" content="Last Title">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("Helmet Title");
    expect(result).not.toContain("Last Title");
    const matches = result.match(/property="og:title"/g);
    expect(matches).toHaveLength(1);
  });

  it("deduplicates og:image, keeping the last one", () => {
    const html = doc({
      head: `<meta property="og:image" content="https://example.com/a.png"><meta property="og:image" content="https://example.com/b.png">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("b.png");
    expect(result).not.toContain("a.png");
  });

  it("deduplicates twitter:card, keeping the last one", () => {
    const html = doc({
      head: `<meta name="twitter:card" content="summary"><meta name="twitter:card" content="summary_large_image">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("summary_large_image");
    const matches = result.match(/name="twitter:card"/g);
    expect(matches).toHaveLength(1);
  });

  it("deduplicates twitter:image (dynamically discovered)", () => {
    const html = doc({
      head: `<meta name="twitter:image" content="https://example.com/a.png"><meta name="twitter:image" content="https://example.com/b.png">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("b.png");
    expect(result).not.toContain("a.png");
    const matches = result.match(/name="twitter:image"/g);
    expect(matches).toHaveLength(1);
  });

  it("deduplicates twitter:site (dynamically discovered)", () => {
    const html = doc({
      head: `<meta name="twitter:site" content="@old"><meta name="twitter:site" content="@new">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("@new");
    expect(result).not.toContain("@old");
    const matches = result.match(/name="twitter:site"/g);
    expect(matches).toHaveLength(1);
  });

  it("deduplicates twitter:creator (dynamically discovered)", () => {
    const html = doc({
      head: `<meta name="twitter:creator" content="@first"><meta name="twitter:creator" content="@second">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("@second");
    expect(result).not.toContain("@first");
  });

  it("deduplicates og:image:alt (dynamically discovered)", () => {
    const html = doc({
      head: `<meta property="og:image:alt" content="Old alt"><meta property="og:image:alt" content="New alt">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("New alt");
    expect(result).not.toContain("Old alt");
    const matches = result.match(/property="og:image:alt"/g);
    expect(matches).toHaveLength(1);
  });

  it("deduplicates <title>, preferring the one with text when last is empty", () => {
    const html = doc({
      head: `<title>Real Title</title><title></title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("Real Title");
    const matches = result.match(/<title>/g);
    expect(matches).toHaveLength(1);
  });

  it("deduplicates <title>, preferring the one with text when last has only whitespace", () => {
    const html = doc({
      head: `<title>Actual Title</title><title>   </title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("Actual Title");
    const matches = result.match(/<title>/g);
    expect(matches).toHaveLength(1);
  });

  it("keeps helmet-marked <title> even if empty when no other has text", () => {
    const html = doc({
      head: `<title></title><title data-rh="true"></title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    // helmet wins even if empty, since no other candidate has text either
    const matches = result.match(/<title/g);
    expect(matches).toHaveLength(1);
  });

  it("prefers title with text over empty helmet-marked title when helmet winner is empty", () => {
    // helmet-marked is the initial winner but it's empty — fallback to first with text
    const html = doc({
      head: `<title>Good Title</title><title data-rh="true"></title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("Good Title");
    const matches = result.match(/<title>/g);
    expect(matches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Head-scoped tag queries — <title>, meta, og, twitter must be from <head>
// ---------------------------------------------------------------------------
describe("head-scoped tag queries", () => {
  it("does NOT let <title> inside SVG in body replace <head> <title>", () => {
    const html = doc({
      head: `<title>Page Title</title>`,
      body: `<svg><title>SVG Icon Title</title></svg><p>Content here with enough words to avoid soft 404 detection for testing purposes</p>`,
    });
    const result = sanitize(html);
    expect(result).toContain("<title>Page Title</title>");
    // SVG is removed by R15, but even before that the <title> should not interfere
    expect(result).not.toContain("SVG Icon Title");
  });

  it("does NOT let <title> inside SVG affect deduplication when no head <title>", () => {
    const html = doc({
      head: `<title>Head Title</title>`,
      body: `<svg><title>Chart Label</title></svg>${wordsBody(50)}`,
    });
    const result = sanitize(html);
    // Only the head title should survive
    expect(result).toContain("Head Title");
    expect(result).not.toContain("Chart Label");
    const titleMatches = result.match(/<title>/g);
    expect(titleMatches).toHaveLength(1);
  });

  it("does NOT let body <meta> tags interfere with head og:title deduplication", () => {
    // Some SPAs mistakenly place meta tags in body
    const html = `<!DOCTYPE html><html><head><meta property="og:title" content="Head OG Title"><title>Test</title></head><body><meta property="og:title" content="Body OG Title"><p>${Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ")}</p></body></html>`;
    const result = sanitize(html);
    // Head og:title should be kept; body meta is outside <head> so it's ignored by dedup
    expect(result).toContain('content="Head OG Title"');
  });

  it("does NOT let body <meta name='twitter:card'> prevent head injection", () => {
    // twitter:card in body should be ignored; sanitizer should inject one in head
    const html = `<!DOCTYPE html><html><head><title>Test</title></head><body><meta name="twitter:card" content="summary"><p>${Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ")}</p></body></html>`;
    const result = sanitize(html);
    // Should still inject twitter:card in head since head didn't have one
    expect(result).toContain('name="twitter:card"');
  });

  it("does NOT let body <meta name='description'> interfere with head deduplication", () => {
    const html = `<!DOCTYPE html><html><head><meta name="description" content="Head desc"><title>Test</title></head><body><meta name="description" content="Body desc"><p>${Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ")}</p></body></html>`;
    const result = sanitize(html);
    expect(result).toContain('content="Head desc"');
  });

  it("does NOT let body <link rel='canonical'> interfere with head canonical", () => {
    const html = `<!DOCTYPE html><html><head><link rel="canonical" href="https://example.com/page"><title>Test</title></head><body><link rel="canonical" href="https://wrong.com/other"><p>${Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ")}</p></body></html>`;
    const result = sanitize(html, { canonicalDomain: "example.com" });
    expect(result).toContain('href="https://example.com/page"');
  });

  it("does NOT let body twitter:title prevent head twitter:title injection", () => {
    const html = `<!DOCTYPE html><html><head><title>My Page</title><meta property="og:title" content="OG Title"></head><body><meta name="twitter:title" content="Body Twitter Title"><p>${Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ")}</p></body></html>`;
    const result = sanitize(html);
    // Should inject twitter:title from og:title since head has no twitter:title
    expect(result).toContain('name="twitter:title"');
    expect(result).toContain('content="OG Title"');
  });
});

// ---------------------------------------------------------------------------
// R3 — Fix canonical URL
// ---------------------------------------------------------------------------
describe("R3: canonical URL fix", () => {
  it("rewrites canonical hostname to canonicalDomain", () => {
    const html = doc({
      head: `<link rel="canonical" href="https://staging.example.com/page">`,
      body: wordsBody(50),
    });
    const result = sanitize(html, { canonicalDomain: "example.com" });
    expect(result).toContain('href="https://example.com/page"');
  });

  it("preserves path, query, and fragment", () => {
    const html = doc({
      head: `<link rel="canonical" href="https://wrong.com/path?q=1#section">`,
      body: wordsBody(50),
    });
    const result = sanitize(html, { canonicalDomain: "example.com" });
    expect(result).toContain('href="https://example.com/path?q=1#section"');
  });

  it("always creates HTTPS URL", () => {
    const html = doc({
      head: `<link rel="canonical" href="http://example.com/page">`,
      body: wordsBody(50),
    });
    const result = sanitize(html, { canonicalDomain: "example.com" });
    expect(result).toContain('href="https://example.com/page"');
  });

  it("is a no-op when canonical is already correct", () => {
    const html = doc({
      head: `<link rel="canonical" href="https://example.com/page">`,
      body: wordsBody(50),
    });
    const result = sanitize(html, { canonicalDomain: "example.com" });
    expect(result).toContain('href="https://example.com/page"');
  });

  it("does not error when canonical is absent", () => {
    const html = doc({
      head: `<title>No canonical</title>`,
      body: wordsBody(50),
    });
    expect(() => sanitize(html)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// R4 — Sync og:url and twitter:url with canonical
// ---------------------------------------------------------------------------
describe("R4: og:url and twitter:url sync", () => {
  it("sets og:url content to match corrected canonical", () => {
    const html = doc({
      head: `<link rel="canonical" href="https://wrong.com/page"><meta property="og:url" content="https://wrong.com/page">`,
      body: wordsBody(50),
    });
    const result = sanitize(html, { canonicalDomain: "example.com" });
    expect(result).toContain(
      '<meta property="og:url" content="https://example.com/page">',
    );
  });

  it("sets twitter:url content to match corrected canonical", () => {
    const html = doc({
      head: `<link rel="canonical" href="https://wrong.com/page"><meta name="twitter:url" content="https://wrong.com/page">`,
      body: wordsBody(50),
    });
    const result = sanitize(html, { canonicalDomain: "example.com" });
    expect(result).toContain(
      '<meta name="twitter:url" content="https://example.com/page">',
    );
  });
});

// ---------------------------------------------------------------------------
// R5 — Fix base tag
// ---------------------------------------------------------------------------
describe("R5: base tag fix", () => {
  it("rewrites <base href> hostname to canonicalDomain", () => {
    const html = doc({
      head: `<base href="https://staging.example.com/">`,
      body: wordsBody(50),
    });
    const result = sanitize(html, { canonicalDomain: "example.com" });
    expect(result).toContain('href="https://example.com/"');
  });

  it("is a no-op when no base tag exists", () => {
    const html = doc({
      head: `<title>No base</title>`,
      body: wordsBody(50),
    });
    expect(() => sanitize(html)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// R6 — Ensure charset and viewport exist
// ---------------------------------------------------------------------------
describe("R6: charset and viewport", () => {
  it("adds <meta charset='utf-8'> when missing", () => {
    const html = doc({
      head: `<title>No charset</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toMatch(/charset/i);
  });

  it("adds viewport when missing", () => {
    const html = doc({
      head: `<title>No viewport</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("viewport");
    expect(result).toContain("width=device-width");
  });

  it("preserves existing charset", () => {
    const html = doc({
      head: `<meta charset="utf-8"><title>Has charset</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    // Should have exactly one <meta charset=...> tag
    const matches = result.match(/<meta charset/gi);
    expect(matches).toHaveLength(1);
  });

  it("preserves existing viewport", () => {
    const html = doc({
      head: `<meta name="viewport" content="width=device-width, initial-scale=1"><title>Has viewport</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("initial-scale=1");
    const matches = result.match(/name="viewport"/g);
    expect(matches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// R7 — Remove inline scripts from head
// ---------------------------------------------------------------------------
describe("R7: inline scripts in head", () => {
  it("removes inline <script> (analytics/tag manager)", () => {
    const html = doc({
      head: `<title>Test</title><script>window.ga=function(){}</script>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).not.toContain("window.ga");
  });

  it("keeps <script src='...'>", () => {
    const html = doc({
      head: `<title>Test</title><script src="https://cdn.example.com/app.js"></script>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('src="https://cdn.example.com/app.js"');
  });

  it("keeps <script type='application/ld+json'>", () => {
    const ldJson = JSON.stringify({ "@type": "WebPage", name: "Test" });
    const html = doc({
      head: `<title>Test</title><script type="application/ld+json">${ldJson}</script>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("application/ld+json");
    expect(result).toContain('"@type"');
  });
});

// ---------------------------------------------------------------------------
// R8 — Remove inline styles from head
// ---------------------------------------------------------------------------
describe("R8: inline styles in head", () => {
  it("removes <style> blocks in head", () => {
    const html = doc({
      head: `<title>Test</title><style>body { margin: 0; }</style>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).not.toContain("<style>");
    expect(result).not.toContain("margin: 0");
  });

  it("keeps <link rel='stylesheet'>", () => {
    const html = doc({
      head: `<title>Test</title><link rel="stylesheet" href="/styles.css">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('rel="stylesheet"');
    expect(result).toContain('href="/styles.css"');
  });
});

// ---------------------------------------------------------------------------
// R9 — Remove browser performance hints
// ---------------------------------------------------------------------------
describe("R9: browser performance hints", () => {
  it("removes <link rel='preload'>", () => {
    const html = doc({
      head: `<title>Test</title><link rel="preload" href="/font.woff2" as="font">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).not.toContain("preload");
  });

  it("removes <link rel='prefetch'>", () => {
    const html = doc({
      head: `<title>Test</title><link rel="prefetch" href="/next-page.js">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).not.toContain("prefetch");
  });

  it("removes <link rel='preconnect'>", () => {
    const html = doc({
      head: `<title>Test</title><link rel="preconnect" href="https://fonts.googleapis.com">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).not.toContain("preconnect");
  });

  it("removes <link rel='dns-prefetch'>", () => {
    const html = doc({
      head: `<title>Test</title><link rel="dns-prefetch" href="https://cdn.example.com">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).not.toContain("dns-prefetch");
  });

  it("removes <link rel='modulepreload'>", () => {
    const html = doc({
      head: `<title>Test</title><link rel="modulepreload" href="/module.js">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).not.toContain("modulepreload");
  });

  it("keeps <link rel='stylesheet'>", () => {
    const html = doc({
      head: `<title>Test</title><link rel="stylesheet" href="/styles.css"><link rel="preload" href="/font.woff2" as="font">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('rel="stylesheet"');
  });

  it("keeps <link rel='icon'>", () => {
    const html = doc({
      head: `<title>Test</title><link rel="icon" href="/favicon.ico"><link rel="preconnect" href="https://fonts.googleapis.com">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('rel="icon"');
  });
});

// ---------------------------------------------------------------------------
// R10 — Remove inline scripts from body
// ---------------------------------------------------------------------------
describe("R10: inline scripts in body", () => {
  it("removes inline scripts in body", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<p>Content</p><script>console.log("track")</script>`,
    });
    const result = sanitize(html);
    expect(result).not.toContain('console.log("track")');
    expect(result).toContain("Content");
  });

  it("removes __NEXT_DATA__ script", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<p>Content</p><script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>`,
    });
    const result = sanitize(html);
    expect(result).not.toContain("__NEXT_DATA__");
  });

  it("keeps JSON-LD in body", () => {
    const ldJson = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Article",
    });
    const html = doc({
      head: `<title>Test</title>`,
      body: `<p>Content</p><script type="application/ld+json">${ldJson}</script>`,
    });
    const result = sanitize(html);
    expect(result).toContain("application/ld+json");
    expect(result).toContain('"@type"');
  });

  it("keeps <script src='...'> in body", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<p>Content</p><script src="/app.js"></script>`,
    });
    const result = sanitize(html);
    expect(result).toContain('src="/app.js"');
  });
});

// ---------------------------------------------------------------------------
// R11 — Remove style blocks from body
// ---------------------------------------------------------------------------
describe("R11: style blocks in body", () => {
  it("removes <style> blocks in body", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<style>.css-1abc { color: red; }</style><p>Content</p>`,
    });
    const result = sanitize(html);
    expect(result).not.toContain("<style>");
    expect(result).not.toContain("css-1abc");
    expect(result).toContain("Content");
  });
});

// ---------------------------------------------------------------------------
// R12 — Remove inline style attributes
// ---------------------------------------------------------------------------
describe("R12: inline style attributes", () => {
  it("removes style='...' from elements", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<div style="color: red; margin: 10px;"><p style="font-size: 14px;">Text</p></div>`,
    });
    const result = sanitize(html);
    expect(result).not.toContain('style="');
    expect(result).toContain("Text");
  });
});

// ---------------------------------------------------------------------------
// R13 — Remove class attributes
// ---------------------------------------------------------------------------
describe("R13: class attributes", () => {
  it("removes class='...' from all elements", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<div class="flex items-center gap-4"><p class="text-sm font-bold">Text</p></div>`,
    });
    const result = sanitize(html);
    expect(result).not.toContain('class="');
    expect(result).toContain("Text");
  });
});

// ---------------------------------------------------------------------------
// R14 — Remove data attributes
// ---------------------------------------------------------------------------
describe("R14: data attributes", () => {
  it("removes data-testid", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<div data-testid="hero"><p>Content</p></div>`,
    });
    const result = sanitize(html);
    expect(result).not.toContain("data-testid");
    expect(result).toContain("Content");
  });

  it("removes data-reactid", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<div data-reactid=".0.1"><p>Content</p></div>`,
    });
    const result = sanitize(html);
    expect(result).not.toContain("data-reactid");
  });

  it("removes data-radix-* attributes", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<div data-radix-collection-item="">Content</div>`,
    });
    const result = sanitize(html);
    expect(result).not.toContain("data-radix");
  });

  it("preserves data-rh='true'", () => {
    const html = doc({
      head: `<title>Test</title><meta name="description" content="desc" data-rh="true">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('data-rh="true"');
  });
});

// ---------------------------------------------------------------------------
// R15 — Remove inline SVGs
// ---------------------------------------------------------------------------
describe("R15: inline SVGs", () => {
  it("removes <svg> elements and all contents", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<p>Before</p><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2L2 22h20L12 2z"/><circle cx="12" cy="12" r="10"/></svg><p>After</p>`,
    });
    const result = sanitize(html);
    expect(result).not.toContain("<svg");
    expect(result).not.toContain("<path");
    expect(result).not.toContain("<circle");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });
});

// ---------------------------------------------------------------------------
// R16 — Remove hidden elements
// ---------------------------------------------------------------------------
describe("R16: hidden elements", () => {
  it("removes elements with hidden attribute", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<div hidden><p>Hidden content</p></div><p>Visible</p>`,
    });
    const result = sanitize(html);
    expect(result).not.toContain("Hidden content");
    expect(result).toContain("Visible");
  });

  it("removes elements with aria-hidden='true'", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<span aria-hidden="true">Icon placeholder</span><p>Visible</p>`,
    });
    const result = sanitize(html);
    expect(result).not.toContain("Icon placeholder");
    expect(result).toContain("Visible");
  });

  it("does NOT remove aria-hidden='false'", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<div aria-hidden="false"><p>Keep this</p></div>`,
    });
    const result = sanitize(html);
    expect(result).toContain("Keep this");
  });
});

// ---------------------------------------------------------------------------
// R17 — Remove noscript blocks
// ---------------------------------------------------------------------------
describe("R17: noscript blocks", () => {
  it("removes <noscript> and contents", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<p>Content</p><noscript><p>Fallback content</p></noscript>`,
    });
    const result = sanitize(html);
    expect(result).not.toContain("<noscript>");
    expect(result).not.toContain("Fallback content");
    expect(result).toContain("Content");
  });
});

// ---------------------------------------------------------------------------
// R18 — Remove HTML comments
// ---------------------------------------------------------------------------
describe("R18: HTML comments", () => {
  it("removes <!-- ... --> comment nodes", () => {
    const html = doc({
      head: `<title>Test</title><!-- build hash: abc123 -->`,
      body: `<!-- react-mount-point --><p>Content</p><!-- end -->`,
    });
    const result = sanitize(html);
    expect(result).not.toContain("build hash");
    expect(result).not.toContain("react-mount-point");
    expect(result).not.toContain("<!-- end -->");
    expect(result).toContain("Content");
  });
});

// ---------------------------------------------------------------------------
// R20 — Set missing og:url
// ---------------------------------------------------------------------------
describe("R20: og:url injection", () => {
  it("adds og:url from canonical URL when missing", () => {
    const html = doc({
      head: `<title>Test</title><link rel="canonical" href="https://example.com/page">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('property="og:url"');
    expect(result).toContain('content="https://example.com/page"');
  });

  it("derives og:url from page URL when no canonical link exists", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html, {
      url: "https://staging.example.com/about",
      canonicalDomain: "example.com",
    });
    expect(result).toContain('property="og:url"');
    expect(result).toContain('content="https://example.com/about"');
  });

  it("derives og:url with correct path and query from page URL when no canonical", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html, {
      url: "https://staging.example.com/products?category=shoes",
      canonicalDomain: "example.com",
    });
    expect(result).toContain('property="og:url"');
    expect(result).toContain("https://example.com/products?category=shoes");
  });
});

// ---------------------------------------------------------------------------
// R21 — Set missing og:type
// ---------------------------------------------------------------------------
describe("R21: og:type injection", () => {
  it("adds og:type 'website' when missing", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('property="og:type"');
    expect(result).toContain('content="website"');
  });

  it("preserves existing og:type", () => {
    const html = doc({
      head: `<title>Test</title><meta property="og:type" content="article">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('content="article"');
    // Should not add a second og:type
    const matches = result.match(/og:type/g);
    expect(matches).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// R22 — Set missing og:title
// ---------------------------------------------------------------------------
describe("R22: og:title injection", () => {
  it("copies from <title> when og:title is missing", () => {
    const html = doc({
      head: `<title>My Page Title</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('property="og:title"');
    expect(result).toContain('content="My Page Title"');
  });

  it("does not add og:title when <title> is also missing", () => {
    const html = doc({
      head: `<meta name="description" content="desc">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).not.toContain("og:title");
  });
});

// ---------------------------------------------------------------------------
// R23 — Set missing og:description
// ---------------------------------------------------------------------------
describe("R23: og:description injection", () => {
  it("copies from meta description when og:description is missing", () => {
    const html = doc({
      head: `<title>Test</title><meta name="description" content="A great page about things">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('property="og:description"');
    expect(result).toContain('content="A great page about things"');
  });

  it("does not add og:description when meta description is also missing", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).not.toContain("og:description");
  });
});

// ---------------------------------------------------------------------------
// R24 — Set missing og:site_name
// ---------------------------------------------------------------------------
describe("R24: og:site_name injection", () => {
  it("sets to domain name when missing", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html, { canonicalDomain: "example.com" });
    expect(result).toContain('property="og:site_name"');
    expect(result).toContain('content="example.com"');
  });
});

// ---------------------------------------------------------------------------
// R25 — Set missing og:locale
// ---------------------------------------------------------------------------
describe("R25: og:locale injection", () => {
  it("extracts from <html lang='fr'> and converts to fr_FR", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: wordsBody(50),
      htmlAttrs: 'lang="fr"',
    });
    const result = sanitize(html);
    expect(result).toContain('property="og:locale"');
    expect(result).toContain('content="fr_FR"');
  });

  it("handles 'en-US' and converts to en_US", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: wordsBody(50),
      htmlAttrs: 'lang="en-US"',
    });
    const result = sanitize(html);
    expect(result).toContain('content="en_US"');
  });

  it("defaults to en_US when no lang attribute", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('property="og:locale"');
    expect(result).toContain('content="en_US"');
  });

  it("maps 'en' to en_US (not en_EN)", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: wordsBody(50),
      htmlAttrs: 'lang="en"',
    });
    const result = sanitize(html);
    expect(result).toContain('content="en_US"');
    expect(result).not.toContain("en_EN");
  });

  it("maps 'ja' to ja_JP", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: wordsBody(50),
      htmlAttrs: 'lang="ja"',
    });
    const result = sanitize(html);
    expect(result).toContain('content="ja_JP"');
  });

  it("maps 'ko' to ko_KR", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: wordsBody(50),
      htmlAttrs: 'lang="ko"',
    });
    const result = sanitize(html);
    expect(result).toContain('content="ko_KR"');
  });

  it("maps 'de' to de_DE (fallback: code uppercased)", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: wordsBody(50),
      htmlAttrs: 'lang="de"',
    });
    const result = sanitize(html);
    expect(result).toContain('content="de_DE"');
  });
});

// ---------------------------------------------------------------------------
// R26 — Set missing twitter:card
// ---------------------------------------------------------------------------
describe("R26: twitter:card injection", () => {
  it("sets summary_large_image when og:image exists", () => {
    const html = doc({
      head: `<title>Test</title><meta property="og:image" content="https://example.com/img.jpg">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('name="twitter:card"');
    expect(result).toContain('content="summary_large_image"');
  });

  it("sets summary when no og:image", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('name="twitter:card"');
    expect(result).toContain('content="summary"');
  });
});

// ---------------------------------------------------------------------------
// R27 — Set missing twitter:title and twitter:description
// ---------------------------------------------------------------------------
describe("R27: twitter:title and twitter:description injection", () => {
  it("copies twitter:title from og:title when missing", () => {
    const html = doc({
      head: `<title>Test</title><meta property="og:title" content="OG Title">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('name="twitter:title"');
    expect(result).toContain('content="OG Title"');
  });

  it("copies twitter:description from og:description when missing", () => {
    const html = doc({
      head: `<title>Test</title><meta property="og:description" content="OG Description">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('name="twitter:description"');
    expect(result).toContain('content="OG Description"');
  });

  it("derives twitter:title from <title> via og:title injection (R22 -> R27 chain)", () => {
    const html = doc({
      head: `<title>Page Title</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    // R22 injects og:title from <title>, then R27 copies to twitter:title
    expect(result).toContain('name="twitter:title"');
    expect(result).toContain('content="Page Title"');
  });
});

// ---------------------------------------------------------------------------
// R28 — Collapse excessive whitespace
// ---------------------------------------------------------------------------
describe("R28: whitespace cleanup", () => {
  it("collapses 3+ blank lines to a single blank line", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<p>First</p>\n\n\n\n\n<p>Second</p>`,
    });
    const result = sanitize(html);
    // Should not have 3+ consecutive newlines
    expect(result).not.toMatch(/\n\s*\n\s*\n\s*\n/);
    expect(result).toContain("First");
    expect(result).toContain("Second");
  });

  it("removes trailing whitespace per line", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<p>Content</p>   \n<p>More</p>  `,
    });
    const result = sanitize(html);
    // No line should end with whitespace before a newline
    const lines = result.split("\n");
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });
});

// ---------------------------------------------------------------------------
// Internal param cleaning (migrated from RenderEngine)
// ---------------------------------------------------------------------------
describe("internal param cleaning", () => {
  it("strips to_html param from canonical href", () => {
    const html = doc({
      head: `<link rel="canonical" href="https://example.com/page?to_html=1&other=2">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).not.toContain("to_html");
    expect(result).toContain("other=2");
  });

  it("strips cache_invalidate param from canonical href", () => {
    const html = doc({
      head: `<link rel="canonical" href="https://example.com/page?cache_invalidate=1">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).not.toContain("cache_invalidate");
  });

  it("strips internal params from og:url", () => {
    const html = doc({
      head: `<link rel="canonical" href="https://example.com/page"><meta property="og:url" content="https://example.com/page?to_html=1">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    // og:url should be synced with canonical (which has no to_html param)
    const ogUrlMatch =
      result.match(/property="og:url"\s+content="([^"]+)"/) ||
      result.match(/content="([^"]+)"\s+property="og:url"/);
    expect(ogUrlMatch).toBeTruthy();
    expect(ogUrlMatch![1]).not.toContain("to_html");
  });

  it("strips internal params from twitter:url", () => {
    const html = doc({
      head: `<link rel="canonical" href="https://example.com/page"><meta name="twitter:url" content="https://example.com/page?to_html=1">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    const twitterUrlMatch =
      result.match(/name="twitter:url"\s+content="([^"]+)"/) ||
      result.match(/content="([^"]+)"\s+name="twitter:url"/);
    expect(twitterUrlMatch).toBeTruthy();
    expect(twitterUrlMatch![1]).not.toContain("to_html");
  });

  it("preserves other query params after stripping internal ones", () => {
    const html = doc({
      head: `<link rel="canonical" href="https://example.com/page?to_html=1&category=shoes&cache_invalidate=1&page=2">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("category=shoes");
    expect(result).toContain("page=2");
    expect(result).not.toContain("to_html");
    expect(result).not.toContain("cache_invalidate");
  });
});

// ---------------------------------------------------------------------------
// Head tag reordering (migrated from RenderEngine)
// ---------------------------------------------------------------------------
describe("head tag reordering", () => {
  it("hoists charset before other tags", () => {
    const html = doc({
      head: `<link rel="stylesheet" href="/s.css"><meta charset="utf-8"><title>Test</title>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    const charsetPos = result.indexOf("charset");
    const stylesheetPos = result.indexOf("stylesheet");
    expect(charsetPos).toBeLessThan(stylesheetPos);
  });

  it("hoists viewport after charset", () => {
    const html = doc({
      head: `<link rel="stylesheet" href="/s.css"><meta name="viewport" content="width=device-width"><meta charset="utf-8">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    const charsetPos = result.indexOf("charset");
    const viewportPos = result.indexOf("viewport");
    const stylesheetPos = result.indexOf("stylesheet");
    expect(charsetPos).toBeLessThan(viewportPos);
    expect(viewportPos).toBeLessThan(stylesheetPos);
  });

  it("hoists title after viewport", () => {
    const html = doc({
      head: `<link rel="stylesheet" href="/s.css"><title>Test</title><meta charset="utf-8">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    const charsetPos = result.indexOf("charset");
    const titlePos = result.indexOf("<title>");
    const stylesheetPos = result.indexOf("stylesheet");
    expect(charsetPos).toBeLessThan(titlePos);
    expect(titlePos).toBeLessThan(stylesheetPos);
  });

  it("places description after title", () => {
    const html = doc({
      head: `<meta name="description" content="A page"><title>Test</title><meta charset="utf-8">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    const titlePos = result.indexOf("<title>");
    const descPos = result.indexOf('name="description"');
    expect(titlePos).toBeLessThan(descPos);
  });

  it("places og: tags after description", () => {
    const html = doc({
      head: `<meta property="og:title" content="OG Title"><meta name="description" content="A page"><title>Test</title><meta charset="utf-8">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    const descPos = result.indexOf('name="description"');
    const ogTitlePos = result.indexOf('property="og:title"');
    expect(descPos).toBeLessThan(ogTitlePos);
  });

  it("places twitter: tags after og: tags", () => {
    const html = doc({
      head: `<meta name="twitter:card" content="summary"><meta property="og:title" content="OG Title"><meta name="description" content="A page"><title>Test</title><meta charset="utf-8">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    const ogTitlePos = result.indexOf('property="og:title"');
    const twitterPos = result.indexOf('name="twitter:card"');
    expect(ogTitlePos).toBeLessThan(twitterPos);
  });

  it("places remaining tags after twitter: tags", () => {
    const html = doc({
      head: `<link rel="icon" href="/favicon.ico"><meta name="twitter:card" content="summary"><meta property="og:title" content="OG Title"><meta name="description" content="A page"><title>Test</title><meta charset="utf-8">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    const twitterPos = result.indexOf('name="twitter:card"');
    const iconPos = result.indexOf('rel="icon"');
    expect(twitterPos).toBeLessThan(iconPos);
  });

  it("enforces full ordering: charset > viewport > title > description > og > twitter > rest", () => {
    // Intentionally scrambled order
    const html = doc({
      head: `
        <link rel="canonical" href="https://example.com/page">
        <meta name="twitter:title" content="Tw Title">
        <meta property="og:description" content="OG Desc">
        <meta name="description" content="A page">
        <title>Test</title>
        <meta name="viewport" content="width=device-width">
        <meta charset="utf-8">
        <meta property="og:title" content="OG Title">
        <meta name="twitter:card" content="summary">
        <link rel="icon" href="/favicon.ico">
      `,
      body: wordsBody(50),
    });
    const result = sanitize(html);

    const charsetPos = result.indexOf("charset");
    const viewportPos = result.indexOf("viewport");
    const titlePos = result.indexOf("<title>");
    const descPos = result.indexOf('name="description"');
    const ogTitlePos = result.indexOf('property="og:title"');
    const ogDescPos = result.indexOf('property="og:description"');
    const twitterCardPos = result.indexOf('name="twitter:card"');
    const twitterTitlePos = result.indexOf('name="twitter:title"');
    const canonicalPos = result.indexOf('rel="canonical"');
    const iconPos = result.indexOf('rel="icon"');

    // charset < viewport < title < description
    expect(charsetPos).toBeLessThan(viewportPos);
    expect(viewportPos).toBeLessThan(titlePos);
    expect(titlePos).toBeLessThan(descPos);

    // description < all og: tags
    expect(descPos).toBeLessThan(ogTitlePos);
    expect(descPos).toBeLessThan(ogDescPos);

    // all og: tags < all twitter: tags
    expect(ogTitlePos).toBeLessThan(twitterCardPos);
    expect(ogDescPos).toBeLessThan(twitterCardPos);
    expect(ogTitlePos).toBeLessThan(twitterTitlePos);
    expect(ogDescPos).toBeLessThan(twitterTitlePos);

    // all twitter: tags < rest (canonical, icon)
    expect(twitterCardPos).toBeLessThan(canonicalPos);
    expect(twitterTitlePos).toBeLessThan(canonicalPos);
    expect(twitterCardPos).toBeLessThan(iconPos);
    expect(twitterTitlePos).toBeLessThan(iconPos);
  });

  it("preserves remaining head content after hoisted tags", () => {
    const html = doc({
      head: `<link rel="stylesheet" href="/s.css"><meta charset="utf-8"><title>Test</title><link rel="icon" href="/favicon.ico">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('rel="icon"');
    expect(result).toContain('href="/favicon.ico"');
  });
});

// ---------------------------------------------------------------------------
// Content preservation
// ---------------------------------------------------------------------------
describe("content preservation", () => {
  it("preserves text content, headings, paragraphs, lists, tables", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `
        <h1>Main Heading</h1>
        <h2>Sub Heading</h2>
        <p>Paragraph text here.</p>
        <ul><li>Item 1</li><li>Item 2</li></ul>
        <ol><li>Ordered 1</li></ol>
        <table><tr><th>Header</th></tr><tr><td>Cell</td></tr></table>
      `,
    });
    const result = sanitize(html);
    expect(result).toContain("Main Heading");
    expect(result).toContain("Sub Heading");
    expect(result).toContain("Paragraph text here.");
    expect(result).toContain("Item 1");
    expect(result).toContain("Ordered 1");
    expect(result).toContain("Header");
    expect(result).toContain("Cell");
  });

  it("preserves links with href", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<a href="https://example.com/other">Link text</a>`,
    });
    const result = sanitize(html);
    expect(result).toContain('href="https://example.com/other"');
    expect(result).toContain("Link text");
  });

  it("preserves images with src and alt", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<img src="https://example.com/photo.jpg" alt="A nice photo">`,
    });
    const result = sanitize(html);
    expect(result).toContain('src="https://example.com/photo.jpg"');
    expect(result).toContain('alt="A nice photo"');
  });

  it("preserves semantic elements (article, section, nav, main, header, footer)", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `
        <header><nav><a href="/">Home</a></nav></header>
        <main><article><section><p>Article content</p></section></article></main>
        <footer><p>Footer text</p></footer>
      `,
    });
    const result = sanitize(html);
    expect(result).toContain("<header>");
    expect(result).toContain("<nav>");
    expect(result).toContain("<main>");
    expect(result).toContain("<article>");
    expect(result).toContain("<section>");
    expect(result).toContain("<footer>");
  });

  it("preserves JSON-LD structured data", () => {
    const ldJson = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: "Test Page",
    });
    const html = doc({
      head: `<title>Test</title><script type="application/ld+json">${ldJson}</script>`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain("application/ld+json");
    expect(result).toContain("schema.org");
  });

  it("preserves external script references", () => {
    const html = doc({
      head: `<title>Test</title><script src="https://cdn.example.com/app.js"></script>`,
      body: `<p>Content</p><script src="/vendor.js"></script>`,
    });
    const result = sanitize(html);
    expect(result).toContain("cdn.example.com/app.js");
    expect(result).toContain("/vendor.js");
  });

  it("preserves external stylesheet references", () => {
    const html = doc({
      head: `<title>Test</title><link rel="stylesheet" href="/styles.css">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('rel="stylesheet"');
  });

  it("preserves id attributes", () => {
    const html = doc({
      head: `<title>Test</title>`,
      body: `<section id="about"><h2>About</h2><p>Content</p></section>`,
    });
    const result = sanitize(html);
    expect(result).toContain('id="about"');
  });

  it("preserves icon/manifest/alternate link tags", () => {
    const html = doc({
      head: `<title>Test</title><link rel="icon" href="/favicon.ico"><link rel="manifest" href="/manifest.json"><link rel="alternate" hreflang="es" href="https://example.com/es/page">`,
      body: wordsBody(50),
    });
    const result = sanitize(html);
    expect(result).toContain('rel="icon"');
    expect(result).toContain('rel="manifest"');
    expect(result).toContain('rel="alternate"');
  });
});

// ---------------------------------------------------------------------------
// Full end-to-end combined test
// ---------------------------------------------------------------------------
describe("full sanitization (combined)", () => {
  it("cleans a realistic Next.js-like dirty page", () => {
    const dirtyHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My App - Home</title>
  <title>My App - Home</title>
  <meta name="description" content="Welcome to my app">
  <meta name="description" content="Welcome to my app">
  <meta name="robots" content="noindex">
  <link rel="canonical" href="https://staging.myapp.com/home?to_html=1">
  <meta property="og:url" content="https://staging.myapp.com/home?to_html=1">
  <meta property="og:title" content="My App">
  <base href="https://staging.myapp.com/">
  <link rel="preload" href="/font.woff2" as="font" crossorigin>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="dns-prefetch" href="https://cdn.example.com">
  <link rel="prefetch" href="/next-page.js">
  <link rel="modulepreload" href="/module.js">
  <link rel="stylesheet" href="/styles.css">
  <link rel="icon" href="/favicon.ico">
  <style>
    body { margin: 0; padding: 0; }
    .hero { background: blue; }
    .text-xl { font-size: 1.25rem; }
  </style>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'GA-12345');
  </script>
  <script src="https://www.googletagmanager.com/gtag/js?id=GA-12345" async></script>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"My App"}</script>
</head>
<body>
  <!-- React root -->
  <div id="__next" class="flex flex-col min-h-screen" data-reactroot="">
    <header class="bg-white shadow-sm border-b" style="position: sticky; top: 0; z-index: 50;">
      <nav class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8" data-testid="main-nav">
        <a href="/" class="text-xl font-bold" data-radix-collection-item="">My App</a>
        <span aria-hidden="true" class="sr-only">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 12h18"/></svg>
        </span>
      </nav>
    </header>
    <main class="flex-1" data-testid="main-content">
      <article class="max-w-3xl mx-auto px-4 py-8">
        <h1 class="text-4xl font-bold mb-4" style="color: #1a202c;">Welcome to My App</h1>
        <p class="text-lg text-gray-600 leading-relaxed">This is a fantastic application that helps you do amazing things.</p>
        <section id="features" class="mt-8">
          <h2 class="text-2xl font-semibold">Features</h2>
          <ul class="list-disc pl-5 mt-4">
            <li class="mb-2">Feature one is great</li>
            <li class="mb-2">Feature two is better</li>
          </ul>
          <img src="/hero.jpg" alt="Hero image" class="w-full rounded-lg shadow" style="max-width: 100%;">
          <a href="/about" class="text-blue-500 underline" data-testid="about-link">Learn more</a>
        </section>
      </article>
    </main>
    <footer class="bg-gray-100 py-8">
      <p class="text-center text-gray-500">&copy; 2024 My App</p>
    </footer>
  </div>
  <div hidden>
    <p>Screen reader only content</p>
  </div>
  <noscript><p>Please enable JavaScript</p></noscript>
  <style>.emotion-abc { display: flex; }</style>
  <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}},"page":"/home"}</script>
  <script>
    window.__NEXT_LOADED_PAGES = [];
    window.__NEXT_REGISTER_PAGE = function() {};
  </script>
  <!-- build: abc123 -->
</body>
</html>`;

    const result = sanitize(dirtyHtml, {
      url: "https://staging.myapp.com/home",
      canonicalDomain: "myapp.com",
    });

    // --- Noise removed ---
    // Inline scripts removed
    expect(result).not.toContain("window.dataLayer");
    expect(result).not.toContain("__NEXT_DATA__");
    expect(result).not.toContain("__NEXT_LOADED_PAGES");
    // Inline styles removed
    expect(result).not.toContain("margin: 0");
    expect(result).not.toContain("emotion-abc");
    // Style attributes removed
    expect(result).not.toContain('style="');
    // Class attributes removed
    expect(result).not.toContain('class="');
    // Data attributes removed (except data-rh)
    expect(result).not.toContain("data-testid");
    expect(result).not.toContain("data-reactroot");
    expect(result).not.toContain("data-radix");
    // SVGs removed
    expect(result).not.toContain("<svg");
    expect(result).not.toContain("<path");
    // Hidden elements removed
    expect(result).not.toContain("Screen reader only content");
    // Noscript removed
    expect(result).not.toContain("Please enable JavaScript");
    // Comments removed
    expect(result).not.toContain("React root");
    expect(result).not.toContain("build: abc123");
    // Performance hints removed
    expect(result).not.toContain("preload");
    expect(result).not.toContain("preconnect");
    expect(result).not.toContain("dns-prefetch");
    expect(result).not.toContain("prefetch");
    expect(result).not.toContain("modulepreload");
    // Noindex removed (not a soft 404, no data-rh)
    expect(result).not.toContain("noindex");
    // Duplicate title/description deduplicated
    const titleMatches = result.match(/<title>/g);
    expect(titleMatches).toHaveLength(1);
    const descMatches = result.match(/name="description"/g);
    expect(descMatches).toHaveLength(1);

    // --- Metadata corrected ---
    // Canonical fixed to canonical domain, internal params stripped
    expect(result).toContain('href="https://myapp.com/home"');
    expect(result).not.toContain("staging.myapp.com");
    expect(result).not.toContain("to_html");
    // og:url synced with canonical
    expect(result).toContain("https://myapp.com/home");
    // Base tag fixed
    expect(result).toContain('href="https://myapp.com/"');

    // --- Content preserved ---
    expect(result).toContain("Welcome to My App");
    expect(result).toContain("fantastic application");
    expect(result).toContain("Feature one is great");
    expect(result).toContain("Feature two is better");
    expect(result).toContain('src="/hero.jpg"');
    expect(result).toContain('alt="Hero image"');
    expect(result).toContain('href="/about"');
    expect(result).toContain("Learn more");
    expect(result).toContain("<header>");
    expect(result).toContain("<main>");
    expect(result).toContain("<article>");
    expect(result).toContain("<footer>");
    expect(result).toContain('id="features"');
    expect(result).toContain('id="__next"');

    // --- Preserved resources ---
    // JSON-LD kept
    expect(result).toContain("application/ld+json");
    expect(result).toContain("schema.org");
    // External script kept
    expect(result).toContain("googletagmanager.com");
    // External stylesheet kept
    expect(result).toContain('rel="stylesheet"');
    // Icon kept
    expect(result).toContain('rel="icon"');

    // --- Metadata injected ---
    // og:type should be present
    expect(result).toContain('property="og:type"');
    // twitter:card should be present
    expect(result).toContain('name="twitter:card"');
    // og:site_name should be present
    expect(result).toContain('property="og:site_name"');
    // og:locale should be present
    expect(result).toContain('property="og:locale"');

    // --- Significant size reduction ---
    expect(result.length).toBeLessThan(dirtyHtml.length);

    // --- No excessive whitespace ---
    expect(result).not.toMatch(/\n\s*\n\s*\n\s*\n/);
  });
});
