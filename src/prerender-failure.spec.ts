import { describe, expect, it } from "vitest";
import {
  RenderFailureError,
  countFailuresByReason,
  toFailureDetail,
} from "./prerender-failure";

describe("toFailureDetail", () => {
  it("returns the detail from a RenderFailureError", () => {
    const e = new RenderFailureError("Origin returned 404", {
      reason: "fetch_error",
      status: 404,
    });
    expect(toFailureDetail(e)).toEqual({ reason: "fetch_error", status: 404 });
  });

  it("omits status when the error carries none", () => {
    const e = new RenderFailureError("Navigation loop detected", {
      reason: "navigation_loop",
    });
    expect(toFailureDetail(e)).toEqual({ reason: "navigation_loop" });
  });

  it("classifies puppeteer redirect-loop errors by message", () => {
    const e = new Error(
      "net::ERR_TOO_MANY_REDIRECTS at https://example.com/loop",
    );
    expect(toFailureDetail(e)).toEqual({ reason: "too_many_redirects" });
  });

  it("falls back to unknown for anything else", () => {
    expect(toFailureDetail(new Error("Render timed out after 65000ms")))
      .toEqual({ reason: "unknown" });
    expect(toFailureDetail("not an error")).toEqual({ reason: "unknown" });
  });
});

describe("countFailuresByReason", () => {
  it("counts reasons, breaking fetch_error out by status", () => {
    expect(
      countFailuresByReason([
        { reason: "fetch_error", status: 404 },
        { reason: "fetch_error", status: 404 },
        { reason: "fetch_error", status: 503 },
        { reason: "navigation_loop" },
        { reason: "unknown" },
      ]),
    ).toEqual({
      "fetch_error(404)": 2,
      "fetch_error(503)": 1,
      navigation_loop: 1,
      unknown: 1,
    });
  });
});
