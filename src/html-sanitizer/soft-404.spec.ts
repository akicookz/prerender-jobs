import { describe, it, expect } from "vitest";
import {
  detectSoft404,
  extractStatusCodeHint,
  hasNoindexMeta,
  hasSoft404Wording,
  looksLikeFailedRender,
} from "./soft-404";

describe("hasSoft404Wording – standalone 404", () => {
  it.each([
    "404",
    "404 Not Found",
    "404-Not found",
    "404 - Page Not Found",
    "Error 404",
    "Error 404.",
    "404!",
    "got a 404, sorry",
    "404\tmissing",
    "404\nmissing",
  ])("matches %j", (text) => {
    expect(hasSoft404Wording(text)).toBe(true);
  });

  it.each([
    "$404.99",
    "404.99",
    "$404",
    "1,404",
    "404,000 results",
    "1404",
    "40404",
    "404s",
    "v404",
    "error404",
    "(404)",
    "/404",
    "404%",
    "404? maybe",
  ])("does not match %j", (text) => {
    expect(hasSoft404Wording(text)).toBe(false);
  });
});

describe("hasSoft404Wording – phrases", () => {
  it.each([
    "Page not found",
    "PAGE NOT FOUND",
    "Page unavailable",
    "This page doesn't exist",
    "This page doesn’t exist",
    "This page does not exist",
    "We couldn't find that page",
    "We couldn’t find that page",
    "Could not find the page",
  ])("matches %j", (text) => {
    expect(hasSoft404Wording(text)).toBe(true);
  });

  it.each(["profound thoughts", "notfound", "This item is no longer available", ""])(
    "does not match %j",
    (text) => {
      expect(hasSoft404Wording(text)).toBe(false);
    },
  );
});

describe("extractStatusCodeHint", () => {
  it("extracts name-before-content", () => {
    expect(
      extractStatusCodeHint(`<meta name="prerender-status-code" content="404">`),
    ).toBe(404);
  });

  it("extracts content-before-name", () => {
    expect(
      extractStatusCodeHint(`<meta content="410" name="prerender-status-code">`),
    ).toBe(410);
  });

  it("handles single quotes", () => {
    expect(
      extractStatusCodeHint(`<meta name='prerender-status-code' content='404'>`),
    ).toBe(404);
  });

  it("is case-insensitive on the name", () => {
    expect(
      extractStatusCodeHint(`<meta name="PRERENDER-STATUS-CODE" content="404">`),
    ).toBe(404);
  });

  it("trims whitespace in content", () => {
    expect(
      extractStatusCodeHint(`<meta name="prerender-status-code" content=" 404 ">`),
    ).toBe(404);
  });

  it("tolerates attributes in between", () => {
    expect(
      extractStatusCodeHint(
        `<meta data-rh="true" name="prerender-status-code" data-x="1" content="404">`,
      ),
    ).toBe(404);
  });

  it("returns undefined for non-numeric content", () => {
    expect(
      extractStatusCodeHint(`<meta name="prerender-status-code" content="abc">`),
    ).toBeUndefined();
  });

  it("returns undefined for empty content", () => {
    expect(
      extractStatusCodeHint(`<meta name="prerender-status-code" content="">`),
    ).toBeUndefined();
  });

  it("returns undefined when the meta is absent", () => {
    expect(extractStatusCodeHint(`<title>404</title>`)).toBeUndefined();
  });
});

describe("hasNoindexMeta", () => {
  it.each([
    `<meta name="robots" content="noindex">`,
    `<meta name="robots" content="noindex, follow">`,
    `<meta content="noindex" name="robots">`,
    `<meta name="googlebot" content="noindex, nofollow">`,
    `<meta name="ROBOTS" content="NOINDEX">`,
    `<meta name='robots' content='noindex'>`,
    `<meta name="robots" content="index, follow"><meta name="googlebot" content="noindex">`,
  ])("detects %j", (html) => {
    expect(hasNoindexMeta(html)).toBe(true);
  });

  it.each([
    `<meta name="robots" content="index, follow">`,
    `<meta name="robots" content="none">`,
    `<meta name="description" content="how to use noindex tags">`,
    `<p>add a noindex meta tag</p>`,
    ``,
  ])("does not detect %j", (html) => {
    expect(hasNoindexMeta(html)).toBe(false);
  });
});

describe("detectSoft404", () => {
  const base = {
    statusCode: 200,
    title: undefined as string | undefined,
    bodyText: "",
    hasNoindex: false,
    statusCodeHint: undefined as number | undefined,
  };

  it("never flags non-200 responses", () => {
    expect(
      detectSoft404({
        ...base,
        statusCode: 204,
        hasNoindex: true,
        title: "404 Not Found",
        statusCodeHint: 404,
      }).isSoft404,
    ).toBe(false);
  });

  it("flags a 404 hint and forwards the status", () => {
    expect(detectSoft404({ ...base, statusCodeHint: 404 })).toEqual({
      isSoft404: true,
      statusCode: 404,
      reason: "status_code_hint",
    });
  });

  it("flags a 410 hint and forwards the status", () => {
    expect(detectSoft404({ ...base, statusCodeHint: 410 })).toEqual({
      isSoft404: true,
      statusCode: 410,
      reason: "status_code_hint",
    });
  });

  it("ignores other hint values", () => {
    expect(detectSoft404({ ...base, statusCodeHint: 301 }).isSoft404).toBe(
      false,
    );
  });

  it("hint takes precedence over noindex + wording", () => {
    const result = detectSoft404({
      ...base,
      statusCodeHint: 410,
      hasNoindex: true,
      title: "404 Not Found",
    });
    expect(result.reason).toBe("status_code_hint");
    expect(result.statusCode).toBe(410);
  });

  it("flags noindex + 404 wording in the title", () => {
    expect(
      detectSoft404({ ...base, hasNoindex: true, title: "Page not found" }),
    ).toEqual({
      isSoft404: true,
      statusCode: 404,
      reason: "noindex_with_404_text",
    });
  });

  it("flags noindex + 404 wording in the body", () => {
    expect(
      detectSoft404({
        ...base,
        hasNoindex: true,
        bodyText: "Sorry, this page doesn’t exist anymore.",
      }).isSoft404,
    ).toBe(true);
  });

  it("does not flag wording without noindex", () => {
    expect(
      detectSoft404({ ...base, title: "404 Not Found" }).isSoft404,
    ).toBe(false);
  });

  it("does not flag noindex without wording", () => {
    expect(
      detectSoft404({
        ...base,
        hasNoindex: true,
        title: "Admin login",
        bodyText: "Email Password Sign in",
      }).isSoft404,
    ).toBe(false);
  });

  it("does not flag thin or empty content on its own", () => {
    expect(detectSoft404({ ...base, bodyText: "" }).isSoft404).toBe(false);
  });
});

describe("looksLikeFailedRender", () => {
  it("flags an empty body regardless of structure", () => {
    expect(
      looksLikeFailedRender({ title: "My Page", wordCount: 0, h1Count: 1 }),
    ).toBe(true);
  });

  it("flags thin content lacking a title", () => {
    expect(
      looksLikeFailedRender({ title: undefined, wordCount: 10, h1Count: 1 }),
    ).toBe(true);
  });

  it("flags thin content lacking an H1", () => {
    expect(
      looksLikeFailedRender({ title: "Some Page", wordCount: 10, h1Count: 0 }),
    ).toBe(true);
  });

  it("does not flag a thin page with both title and H1 (login form)", () => {
    expect(
      looksLikeFailedRender({ title: "Log in", wordCount: 10, h1Count: 1 }),
    ).toBe(false);
  });

  it("does not flag normal content", () => {
    expect(
      looksLikeFailedRender({ title: "Welcome", wordCount: 400, h1Count: 1 }),
    ).toBe(false);
  });
});
