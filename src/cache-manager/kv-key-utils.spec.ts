import { describe, it, expect } from "vitest";
import { buildKvKey, stripTrackingParams } from "./kv-key-utils";

describe("stripTrackingParams", () => {
  it("strips utm_* params", () => {
    expect(
      stripTrackingParams(
        "https://example.com/page?utm_source=x&utm_medium=email",
      ),
    ).toBe("https://example.com/page");
  });

  it("strips click-ID params (fbclid, gclid, msclkid, ...)", () => {
    expect(
      stripTrackingParams("https://example.com/page?fbclid=abc&gclid=def"),
    ).toBe("https://example.com/page");
  });

  it("is case-insensitive on param names", () => {
    expect(stripTrackingParams("https://example.com/page?FBCLID=abc")).toBe(
      "https://example.com/page",
    );
  });

  it("preserves content params alongside tracking params", () => {
    expect(
      stripTrackingParams("https://example.com/page?ref=nav&utm_source=x"),
    ).toBe("https://example.com/page?ref=nav");
  });

  it("returns the input unchanged when there is nothing to strip", () => {
    const url = "https://example.com/page?page=2&q=hello";
    expect(stripTrackingParams(url)).toBe(url);
  });

  it("returns unparseable input unchanged", () => {
    expect(stripTrackingParams("not a url")).toBe("not a url");
  });
});

describe("buildKvKey – tracking params", () => {
  it("gives tracking-param variants the same key as the base URL", () => {
    const base = buildKvKey({ targetUrl: "https://example.com/page" });
    const variant = buildKvKey({
      targetUrl: "https://example.com/page?utm_source=x&fbclid=abc",
    });
    expect(variant).toBe(base);
  });

  it("keeps content params in the key", () => {
    const base = buildKvKey({ targetUrl: "https://example.com/page" });
    const withRef = buildKvKey({
      targetUrl: "https://example.com/page?ref=nav",
    });
    expect(withRef).not.toBe(base);
    expect(withRef).toContain("ref=nav");
  });
});
