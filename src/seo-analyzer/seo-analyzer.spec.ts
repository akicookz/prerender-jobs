import { describe, it, expect } from "vitest";
import { SeoAnalyzer } from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHtml({
  title,
  metaDescription,
  canonical,
  robotsMeta,
  viewport,
  h1s = [],
  ogTitle,
  ogDescription,
  ogImage,
  twitterCard,
  twitterTitle,
  headExtra,
  body = "",
}: {
  title?: string;
  metaDescription?: string;
  canonical?: string;
  robotsMeta?: string;
  viewport?: string;
  h1s?: string[];
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  twitterCard?: string;
  twitterTitle?: string;
  headExtra?: string;
  body?: string;
}): string {
  const head = [
    title ? `<title>${title}</title>` : "",
    metaDescription
      ? `<meta name="description" content="${metaDescription}">`
      : "",
    canonical ? `<link rel="canonical" href="${canonical}">` : "",
    robotsMeta ? `<meta name="robots" content="${robotsMeta}">` : "",
    viewport ? `<meta name="viewport" content="${viewport}">` : "",
    ogTitle ? `<meta property="og:title" content="${ogTitle}">` : "",
    ogDescription
      ? `<meta property="og:description" content="${ogDescription}">`
      : "",
    ogImage ? `<meta property="og:image" content="${ogImage}">` : "",
    twitterCard ? `<meta name="twitter:card" content="${twitterCard}">` : "",
    twitterTitle ? `<meta name="twitter:title" content="${twitterTitle}">` : "",
    headExtra ?? "",
  ]
    .filter(Boolean)
    .join("\n");

  const h1Elements = h1s.map((text) => `<h1>${text}</h1>`).join("\n");

  return `<!DOCTYPE html><html><head>${head}</head><body>${h1Elements}${body}</body></html>`;
}

/** Generate a body string with approximately `n` words */
function wordsBody(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
}

const BASE_URL = "https://example.com/page";

function analyze(
  overrides: Parameters<typeof buildHtml>[0] & {
    url?: string;
    xRobotsTag?: string | null;
  } = {},
) {
  const { url = BASE_URL, xRobotsTag = null, ...htmlOpts } = overrides;
  const html = buildHtml(htmlOpts);
  return SeoAnalyzer.register({
    html,
    url,
    statusCode: 200,
    xRobotsTag,
  }).analyze();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SeoAnalyzer.register()", () => {
  it("throws when status code is >= 400", () => {
    expect(() =>
      SeoAnalyzer.register({
        html: "<html></html>",
        url: BASE_URL,
        statusCode: 404,
        xRobotsTag: null,
      }),
    ).toThrow("Status code is not 200~399");
  });

  it("accepts 3xx status codes", () => {
    expect(() =>
      SeoAnalyzer.register({
        html: "<html><body>ok</body></html>",
        url: BASE_URL,
        statusCode: 301,
        xRobotsTag: null,
      }),
    ).not.toThrow();
  });

  it("throws when URL is empty", () => {
    expect(() =>
      SeoAnalyzer.register({
        html: "<html></html>",
        url: "",
        statusCode: 200,
        xRobotsTag: null,
      }),
    ).toThrow("URL is required");
  });

  it("throws when HTML is empty", () => {
    expect(() =>
      SeoAnalyzer.register({
        html: "",
        url: BASE_URL,
        statusCode: 200,
        xRobotsTag: null,
      }),
    ).toThrow("HTML is required");
  });

  it("returns SeoAnalyzer instance on valid input", () => {
    const analyzer = SeoAnalyzer.register({
      html: "<html><body>content</body></html>",
      url: BASE_URL,
      statusCode: 200,
      xRobotsTag: null,
    });
    expect(analyzer).toBeInstanceOf(SeoAnalyzer);
  });

  it("accepts status codes 200-299", () => {
    expect(() =>
      SeoAnalyzer.register({
        html: "<html><body>ok</body></html>",
        url: BASE_URL,
        statusCode: 201,
        xRobotsTag: null,
      }),
    ).not.toThrow();
  });
});

describe("analyze() – title", () => {
  it("titleStatus is 'missing' when no <title>", () => {
    const result = analyze({ body: wordsBody(400) });
    expect(result.titleStatus).toBe("missing");
    expect(result.title).toBeUndefined();
  });

  it("titleStatus is 'too_short' when title < 10 chars", () => {
    const result = analyze({ title: "Short", body: wordsBody(400) });
    expect(result.titleStatus).toBe("too_short");
    expect(result.titleLength).toBe(5);
  });

  it("titleStatus is 'ok' when title is 10–60 chars", () => {
    const result = analyze({
      title: "A good SEO title that fits",
      body: wordsBody(400),
    });
    expect(result.titleStatus).toBe("ok");
  });

  it("titleStatus is 'too_long' when title > 60 chars", () => {
    const longTitle =
      "This title is way too long and exceeds the sixty character limit set";
    expect(longTitle.length).toBeGreaterThan(60);
    const result = analyze({ title: longTitle, body: wordsBody(400) });
    expect(result.titleStatus).toBe("too_long");
  });
});

describe("analyze() – meta description", () => {
  it("metaDescStatus is 'missing' when no meta description", () => {
    const result = analyze({ body: wordsBody(400) });
    expect(result.metaDescStatus).toBe("missing");
  });

  it("metaDescStatus is 'too_short' when description < 50 chars", () => {
    const result = analyze({
      metaDescription: "Too short desc",
      body: wordsBody(400),
    });
    expect(result.metaDescStatus).toBe("too_short");
  });

  it("metaDescStatus is 'ok' when description is 50–160 chars", () => {
    const desc = "A".repeat(100);
    const result = analyze({ metaDescription: desc, body: wordsBody(400) });
    expect(result.metaDescStatus).toBe("ok");
  });

  it("metaDescStatus is 'too_long' when description > 160 chars", () => {
    const desc = "A".repeat(161);
    const result = analyze({ metaDescription: desc, body: wordsBody(400) });
    expect(result.metaDescStatus).toBe("too_long");
  });
});

describe("analyze() – canonical", () => {
  it("canonical is 'missing' when no canonical link", () => {
    const result = analyze({ body: wordsBody(400) });
    expect(result.canonical).toBe("missing");
  });

  it("canonical is 'ok' when canonical matches current URL", () => {
    const result = analyze({ canonical: BASE_URL, body: wordsBody(400) });
    expect(result.canonical).toBe("ok");
  });

  it("canonical is 'mismatch' when canonical points to a different path", () => {
    const result = analyze({
      canonical: "https://example.com/other",
      body: wordsBody(400),
    });
    expect(result.canonical).toBe("mismatch");
  });

  it("canonical is 'mismatch' when canonical points to a different host", () => {
    const result = analyze({
      canonical: "https://other.com/page",
      body: wordsBody(400),
    });
    expect(result.canonical).toBe("mismatch");
  });

  it("canonical is 'mismatch' for an invalid canonical URL", () => {
    const result = analyze({
      canonical: "not-a-valid-url",
      body: wordsBody(400),
    });
    expect(result.canonical).toBe("mismatch");
  });
});

describe("analyze() – H1 tags", () => {
  it("h1Status is 'missing' when no H1", () => {
    const result = analyze({ body: wordsBody(400) });
    expect(result.h1Status).toBe("missing");
    expect(result.h1Count).toBe(0);
  });

  it("h1Status is 'ok' with exactly one H1", () => {
    const result = analyze({ h1s: ["Main heading"], body: wordsBody(400) });
    expect(result.h1Status).toBe("ok");
    expect(result.h1Count).toBe(1);
    expect(result.h1).toBe("Main heading");
  });

  it("h1Status is 'multiple' with more than one H1", () => {
    const result = analyze({ h1s: ["First", "Second"], body: wordsBody(400) });
    expect(result.h1Status).toBe("multiple");
    expect(result.h1Count).toBe(2);
  });
});

describe("analyze() – indexability", () => {
  it("is indexable when no robots meta or X-Robots-Tag", () => {
    const result = analyze({ body: wordsBody(400) });
    expect(result.indexable).toBe(true);
  });

  it("is not indexable with 'noindex' in robots meta", () => {
    const result = analyze({
      robotsMeta: "noindex, nofollow",
      body: wordsBody(400),
    });
    expect(result.indexable).toBe(false);
  });

  it("is indexable with 'index, follow' robots meta", () => {
    const result = analyze({
      robotsMeta: "index, follow",
      body: wordsBody(400),
    });
    expect(result.indexable).toBe(true);
  });

  it("is not indexable when X-Robots-Tag contains noindex", () => {
    const result = analyze({ xRobotsTag: "noindex", body: wordsBody(400) });
    expect(result.indexable).toBe(false);
  });

  it("is not indexable when X-Robots-Tag is case-insensitive NOINDEX", () => {
    const result = analyze({ xRobotsTag: "NOINDEX", body: wordsBody(400) });
    expect(result.indexable).toBe(false);
  });
});

describe("analyze() – soft 404 detection", () => {
  it("does not flag '404' in title without noindex", () => {
    const result = analyze({
      title: "404 - Page Not Found",
      body: wordsBody(400),
    });
    expect(result.isSoft404).toBe(false);
    expect(result.statusCode).toBe(200);
  });

  it("flags '404' in title combined with a noindex robots meta", () => {
    const result = analyze({
      title: "404 - Page Not Found",
      robotsMeta: "noindex",
      body: wordsBody(400),
    });
    expect(result.isSoft404).toBe(true);
    expect(result.soft404Reason).toBe("noindex_with_404_text");
    expect(result.soft404StatusCode).toBe(404);
    expect(result.statusCode).toBe(404);
  });

  it("flags 404 wording in the body combined with noindex", () => {
    const result = analyze({
      title: "Example",
      robotsMeta: "noindex",
      body: `${wordsBody(100)} <p>Sorry, page not found.</p>`,
    });
    expect(result.isSoft404).toBe(true);
  });

  it("flags entity-encoded curly-apostrophe wording combined with noindex", () => {
    const result = analyze({
      title: "Example",
      robotsMeta: "noindex",
      body: `${wordsBody(100)} <p>Sorry, this page doesn&#8217;t exist.</p>`,
    });
    expect(result.isSoft404).toBe(true);
  });

  it("flags googlebot noindex combined with 404 wording", () => {
    const result = analyze({
      title: "Page Not Found",
      headExtra: `<meta name="googlebot" content="noindex">`,
      body: wordsBody(400),
    });
    expect(result.isSoft404).toBe(true);
  });

  it("does not flag noindex without 404 wording", () => {
    const result = analyze({
      title: "Admin login",
      robotsMeta: "noindex",
      body: wordsBody(30),
    });
    expect(result.isSoft404).toBe(false);
  });

  it("does not flag thin or empty content on its own", () => {
    expect(analyze({ body: wordsBody(15) }).isSoft404).toBe(false);
    expect(analyze({ title: "My Page", body: "" }).isSoft404).toBe(false);
  });

  it("does not treat robots 'none' as noindex", () => {
    const result = analyze({
      title: "Page Not Found",
      robotsMeta: "none",
      body: wordsBody(400),
    });
    expect(result.isSoft404).toBe(false);
  });

  it("flags a prerender-status-code hint and forwards 410", () => {
    const result = analyze({
      title: "Gone",
      headExtra: `<meta name="prerender-status-code" content="410">`,
      body: wordsBody(400),
    });
    expect(result.isSoft404).toBe(true);
    expect(result.soft404Reason).toBe("status_code_hint");
    expect(result.soft404StatusCode).toBe(410);
    expect(result.statusCode).toBe(410);
  });

  it("ignores bogus prerender-status-code values", () => {
    const result = analyze({
      title: "Example",
      headExtra: `<meta name="prerender-status-code" content="301">`,
      body: wordsBody(400),
    });
    expect(result.isSoft404).toBe(false);
  });

  it("returns isSoft404=false for normal content with a valid title", () => {
    const result = analyze({
      title: "Welcome to Example",
      body: wordsBody(400),
    });
    expect(result.isSoft404).toBe(false);
    expect(result.statusCode).toBe(200);
  });
});

describe("analyze() – OG tags", () => {
  it("hasOgTags is true when og:title, og:description, and og:image are present", () => {
    const result = analyze({
      ogTitle: "My Page",
      ogDescription: "A description",
      ogImage: "https://example.com/img.jpg",
      body: wordsBody(400),
    });
    expect(result.hasOgTags).toBe(true);
  });

  it("hasOgTags is false when og:image is missing", () => {
    const result = analyze({
      ogTitle: "My Page",
      ogDescription: "A description",
      body: wordsBody(400),
    });
    expect(result.hasOgTags).toBe(false);
  });

  it("hasOgTags is false when no OG tags are present", () => {
    const result = analyze({ body: wordsBody(400) });
    expect(result.hasOgTags).toBe(false);
  });
});

describe("analyze() – Twitter tags", () => {
  it("hasTwitterTags is true with twitter:card and twitter:title", () => {
    const result = analyze({
      twitterCard: "summary_large_image",
      twitterTitle: "My Page",
      body: wordsBody(400),
    });
    expect(result.hasTwitterTags).toBe(true);
  });

  it("hasTwitterTags is true with twitter:card and og:title (fallback)", () => {
    const result = analyze({
      twitterCard: "summary",
      ogTitle: "My Page",
      body: wordsBody(400),
    });
    expect(result.hasTwitterTags).toBe(true);
  });

  it("hasTwitterTags is false without twitter:card", () => {
    const result = analyze({
      twitterTitle: "My Page",
      body: wordsBody(400),
    });
    expect(result.hasTwitterTags).toBe(false);
  });
});

describe("analyze() – viewport", () => {
  it("hasViewport is true when viewport meta is present", () => {
    const result = analyze({
      viewport: "width=device-width, initial-scale=1",
      body: wordsBody(400),
    });
    expect(result.hasViewport).toBe(true);
    expect(result.viewport).toBe("width=device-width, initial-scale=1");
  });

  it("hasViewport is false when viewport meta is absent", () => {
    const result = analyze({ body: wordsBody(400) });
    expect(result.hasViewport).toBe(false);
  });
});

describe("analyze() – word count and content status", () => {
  it("counts words correctly", () => {
    const result = analyze({ body: wordsBody(400) });
    expect(result.wordCount).toBe(400);
  });

  it("contentStatus is 'very_thin' when word count < 300", () => {
    const result = analyze({
      title: "Normal Page Title",
      body: wordsBody(200),
    });
    expect(result.contentStatus).toBe("very_thin");
  });

  it("contentStatus is 'thin' when word count is 300–599", () => {
    const result = analyze({
      title: "Normal Page Title",
      body: wordsBody(400),
    });
    expect(result.contentStatus).toBe("thin");
  });

  it("contentStatus is 'ok' when word count >= 600", () => {
    const result = analyze({
      title: "Normal Page Title",
      body: wordsBody(600),
    });
    expect(result.contentStatus).toBe("ok");
  });
});

describe("analyze() – status code is passed through", () => {
  it("includes the status code in the result", () => {
    const result = analyze({});
    expect(result.statusCode).toBe(200);
  });
});
