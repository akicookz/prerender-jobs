import { describe, it, expect } from "vitest";
import { detectMetadataLoss } from "./detect-metadata-loss";

function doc(head: string): string {
  return `<html><head>${head}</head><body></body></html>`;
}

describe("detectMetadataLoss", () => {
  it("returns empty when no properties are lost", () => {
    const html = doc(
      '<title>Hello</title><meta name="description" content="desc"><meta property="og:title" content="Hello">',
    );
    const result = detectMetadataLoss(html, html);
    expect(result.lostProperties).toEqual([]);
  });

  it("detects lost title", () => {
    const original = doc("<title>Hello</title>");
    const sanitized = doc("");
    const result = detectMetadataLoss(original, sanitized);
    expect(result.lostProperties).toContain("title");
  });

  it("detects lost meta description", () => {
    const original = doc('<meta name="description" content="My page">');
    const sanitized = doc("");
    const result = detectMetadataLoss(original, sanitized);
    expect(result.lostProperties).toContain("meta:description");
  });

  it("detects lost OG properties", () => {
    const original = doc(
      '<meta property="og:title" content="Hello"><meta property="og:image" content="https://img.png"><meta property="og:description" content="desc">',
    );
    const sanitized = doc('<meta property="og:title" content="Hello">');
    const result = detectMetadataLoss(original, sanitized);
    expect(result.lostProperties).toContain("og:image");
    expect(result.lostProperties).toContain("og:description");
    expect(result.lostProperties).not.toContain("og:title");
  });

  it("detects lost Twitter properties", () => {
    const original = doc(
      '<meta name="twitter:card" content="summary"><meta name="twitter:title" content="Hello">',
    );
    const sanitized = doc('<meta name="twitter:card" content="summary">');
    const result = detectMetadataLoss(original, sanitized);
    expect(result.lostProperties).toContain("twitter:title");
    expect(result.lostProperties).not.toContain("twitter:card");
  });

  it("does not flag properties missing in both", () => {
    const original = doc("<title>Hello</title>");
    const sanitized = doc("<title>Hello</title>");
    const result = detectMetadataLoss(original, sanitized);
    expect(result.lostProperties).toEqual([]);
  });

  it("ignores properties with empty content in original", () => {
    const original = doc(
      '<meta property="og:title" content=""><meta name="description" content="  "><title>  </title>',
    );
    const sanitized = doc("");
    const result = detectMetadataLoss(original, sanitized);
    expect(result.lostProperties).toEqual([]);
  });

  it("detects multiple categories lost simultaneously", () => {
    const original = doc(
      '<title>Hello</title><meta name="description" content="desc"><meta property="og:title" content="Hello"><meta name="twitter:card" content="summary">',
    );
    const sanitized = doc("");
    const result = detectMetadataLoss(original, sanitized);
    expect(result.lostProperties).toContain("title");
    expect(result.lostProperties).toContain("meta:description");
    expect(result.lostProperties).toContain("og:title");
    expect(result.lostProperties).toContain("twitter:card");
    expect(result.lostProperties).toHaveLength(4);
  });
});
