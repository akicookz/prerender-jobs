import { describe, expect, it } from "vitest";
import {
  BEACON_MIN_HITS,
  BEACON_MIN_SPAN_MS,
  BeaconDetector,
} from "./beacon-detector";

describe("BeaconDetector.endpointKey", () => {
  it("strips the query, collapses the trailing slash, and normalizes the host", () => {
    expect(
      BeaconDetector.endpointKey("https://CT.Pinterest.com/v3/?cb=123&ed=x"),
    ).toBe("ct.pinterest.com/v3");
    expect(BeaconDetector.endpointKey("https://example.com/")).toBe(
      "example.com/",
    );
    expect(
      BeaconDetector.endpointKey("https://example.com/api/collect?id=1"),
    ).toBe(BeaconDetector.endpointKey("https://example.com/api/collect?id=2"));
  });

  it("accepts an already-parsed URL", () => {
    expect(
      BeaconDetector.endpointKey(new URL("https://example.com/api/x?y=1")),
    ).toBe("example.com/api/x");
  });

  it("returns null for unparseable URLs", () => {
    expect(BeaconDetector.endpointKey("not a url")).toBeNull();
  });
});

describe("BeaconDetector classification", () => {
  const URL_A = "https://site.com/OvxsTKvhWzbEjwgbvZxw?cb=1";

  it("does not classify a burst of hits inside the span window", () => {
    const session = BeaconDetector.register().startRender();
    const t0 = 1_000_000;
    // A GraphQL-style load burst: many hits, all within the first seconds.
    for (let i = 0; i < 10; i++) {
      const rec = session.record(URL_A, t0 + i * 100);
      expect(rec?.classified).toBe(false);
    }
  });

  it("classifies repeat-fire spanning the window within one render, exactly once", () => {
    const d = BeaconDetector.register();
    const session = d.startRender();
    const t0 = 1_000_000;
    expect(session.record(URL_A, t0)?.classified).toBe(false);
    expect(session.record(URL_A, t0 + 1_000)?.classified).toBe(false);
    // Third hit, past the span threshold → classifies on this edge.
    const rec = session.record(URL_A, t0 + BEACON_MIN_SPAN_MS);
    expect(rec).toEqual({
      key: "site.com/OvxsTKvhWzbEjwgbvZxw",
      classified: true,
      newlyClassified: true,
    });
    // Later hits are classified but not "newly".
    const later = session.record(URL_A, t0 + BEACON_MIN_SPAN_MS + 500);
    expect(later?.classified).toBe(true);
    expect(later?.newlyClassified).toBe(false);
    expect(d.isBeacon(URL_A)).toBe(true);
    expect(d.isBeaconKey("site.com/OvxsTKvhWzbEjwgbvZxw")).toBe(true);
    expect(d.classifiedEndpoints()).toEqual(["site.com/OvxsTKvhWzbEjwgbvZxw"]);
  });

  it("never classifies a once-per-render data endpoint, however many renders run", () => {
    const d = BeaconDetector.register();
    const t0 = 1_000_000;
    // A page's Supabase/GraphQL fetch: one hit per render, across many
    // renders spread far beyond the span window. Must never classify —
    // this was the cross-render-accumulation false positive.
    for (let render = 0; render < 20; render++) {
      const rec = d
        .startRender()
        .record("https://x.supabase.co/rest/v1/articles?select=*", t0 + render * 60_000);
      expect(rec?.classified).toBe(false);
    }
    expect(d.isBeacon("https://x.supabase.co/rest/v1/articles")).toBe(false);
  });

  it("shares a verdict job-wide: later renders see it from the first hit", () => {
    const d = BeaconDetector.register();
    const t0 = 1_000_000;
    const s1 = d.startRender();
    s1.record(URL_A, t0);
    s1.record(URL_A, t0 + 3_000);
    s1.record(URL_A, t0 + BEACON_MIN_SPAN_MS + 1);
    const s2 = d.startRender();
    expect(s2.record(URL_A, t0 + 100_000)?.classified).toBe(true);
  });

  it("needs BEACON_MIN_HITS within the render even when the span has elapsed", () => {
    const session = BeaconDetector.register().startRender();
    const t0 = 1_000_000;
    for (let i = 1; i < BEACON_MIN_HITS; i++) {
      expect(session.record(URL_A, t0 + i * 60_000)?.classified).toBe(false);
    }
    expect(
      session.record(URL_A, t0 + BEACON_MIN_HITS * 60_000)?.classified,
    ).toBe(true);
  });

  it("accumulates hits across query-string variants of one endpoint", () => {
    const session = BeaconDetector.register().startRender();
    const t0 = 1_000_000;
    session.record("https://bat.bing.com/action/0?ti=1", t0);
    session.record("https://bat.bing.com/action/0?ti=2", t0 + 3_000);
    const rec = session.record("https://bat.bing.com/action/0?ti=3", t0 + 6_000);
    expect(rec?.newlyClassified).toBe(true);
  });

  it("caps per-render tracking without starving the next render", () => {
    const d = BeaconDetector.register();
    const t0 = 1_000_000;
    const s1 = d.startRender();
    for (let i = 0; i < 600; i++) {
      s1.record(`https://site.com/endpoint-${i}`, t0);
    }
    // Endpoint past the cap: repeat-firing it in THIS render never
    // classifies (untracked)...
    const over = "https://site.com/endpoint-599";
    s1.record(over, t0 + 6_000);
    s1.record(over, t0 + 12_000);
    expect(d.isBeacon(over)).toBe(false);
    // ...but the next render starts with a fresh map and classifies it.
    const s2 = d.startRender();
    s2.record(over, t0 + 20_000);
    s2.record(over, t0 + 23_000);
    s2.record(over, t0 + 20_000 + BEACON_MIN_SPAN_MS);
    expect(d.isBeacon(over)).toBe(true);
  });
});
