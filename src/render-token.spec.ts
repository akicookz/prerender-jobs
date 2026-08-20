import { describe, expect, it } from "vitest";

import { renderTokenFor } from "./render-engine";

const HOSTS = new Set(["example.com", "www.example.com", "origin.fly.dev"]);
const TOKEN = "4affb2bce678ddf8b018832d0345aaec";

describe("renderTokenFor", () => {
  it("sends to the customer's own hosts over https", () => {
    for (const url of [
      "https://example.com/p",
      "https://www.example.com/p",
      "https://origin.fly.dev/p",
      "https://EXAMPLE.COM/p",
      "https://example.com./p",
      "https://example.com:8443/p",
    ]) {
      expect(renderTokenFor(new URL(url), HOSTS, TOKEN)).toBe(TOKEN);
    }
  });

  it("never sends to another host", () => {
    for (const url of [
      "https://cdn.example.com/a.js",
      "https://notexample.com/p",
      "https://evil.tld/p",
    ]) {
      expect(renderTokenFor(new URL(url), HOSTS, TOKEN)).toBeNull();
    }
  });

  it("never sends over plain http", () => {
    expect(
      renderTokenFor(new URL("http://example.com/p"), HOSTS, TOKEN),
    ).toBeNull();
  });

  it("is a no-op without a token", () => {
    expect(
      renderTokenFor(new URL("https://example.com/p"), HOSTS, null),
    ).toBeNull();
    expect(
      renderTokenFor(new URL("https://example.com/p"), new Set(), TOKEN),
    ).toBeNull();
  });
});
