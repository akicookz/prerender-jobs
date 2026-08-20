import { describe, expect, it } from "vitest";

import { parseRenderTokenHosts } from "./load-config";
import { normalizeTokenHost } from "./util";

describe("normalizeTokenHost", () => {
  it("takes the host out of whatever shape the value arrives in", () => {
    for (const [input, expected] of [
      ["example.com", "example.com"],
      ["  Example.COM.  ", "example.com"],
      ["https://example.com/base/", "example.com"],
      ["example.com:8443", "example.com"],
      ["user:pass@example.com", "example.com"],
      ["http://user@example.com:80/x", "example.com"],
      ["[2001:db8::1]:443", "[2001:db8::1]"],
    ] as const) {
      expect(normalizeTokenHost(input)).toBe(expected);
    }
  });

  it("returns empty for values with no host", () => {
    for (const input of ["", "   ", "https://", "/just/a/path"]) {
      expect(normalizeTokenHost(input)).toBe("");
    }
  });
});

describe("parseRenderTokenHosts", () => {
  it("accepts the list the worker sends", () => {
    expect(parseRenderTokenHosts('["example.com","www.example.com"]')).toEqual({
      hosts: ["example.com", "www.example.com"],
      problem: null,
    });
  });

  it("names why the token will not be sent", () => {
    expect(parseRenderTokenHosts(undefined).problem).toBe("unset");
    expect(parseRenderTokenHosts("   ").problem).toBe("unset");
    expect(parseRenderTokenHosts("example.com").problem).toBe("invalid_json");
    expect(parseRenderTokenHosts('{"host":"example.com"}').problem).toBe(
      "invalid_json",
    );
    expect(parseRenderTokenHosts("[]").problem).toBe("no_usable_hosts");
    expect(parseRenderTokenHosts('["   ", 42]').problem).toBe(
      "no_usable_hosts",
    );
  });
});

describe("host rule shared by the interceptor", () => {
  it("treats a trailing dot the same for both secrets", () => {
    // The internal key and the token compare against the same normalized host,
    // so https://example.com. cannot get one and not the other.
    expect(normalizeTokenHost("example.com.")).toBe(
      normalizeTokenHost("example.com"),
    );
  });
});
