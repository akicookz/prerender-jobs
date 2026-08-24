import { describe, expect, it } from "vitest";
import {
  BEACON_MIN_HITS,
  BEACON_MIN_POST_STABLE_HITS,
  BEACON_MIN_SPAN_MS,
  BeaconDetector,
} from "./beacon-detector";

const STABLE = true;
const UNSTABLE = false;

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
  const BEACON = "https://site.com/OvxsTKvhWzbEjwgbvZxw?cb=1";

  it("classifies repeat-fire that keeps going after the DOM is stable", () => {
    const d = BeaconDetector.register();
    const session = d.startRender();
    const t0 = 1_000_000;
    expect(session.record(BEACON, t0, UNSTABLE)?.classified).toBe(false);
    expect(session.record(BEACON, t0 + 3_000, STABLE)?.classified).toBe(false);
    // Third hit: span satisfied and the second post-stable hit lands.
    const rec = session.record(BEACON, t0 + BEACON_MIN_SPAN_MS, STABLE);
    expect(rec).toEqual({
      key: "site.com/OvxsTKvhWzbEjwgbvZxw",
      classified: true,
      newlyClassified: true,
    });
    const later = session.record(BEACON, t0 + BEACON_MIN_SPAN_MS + 500, STABLE);
    expect(later?.classified).toBe(true);
    expect(later?.newlyClassified).toBe(false);
    expect(d.isBeacon(BEACON)).toBe(true);
    expect(d.isBeaconKey("site.com/OvxsTKvhWzbEjwgbvZxw")).toBe(true);
    expect(d.classifiedEndpoints()).toEqual(["site.com/OvxsTKvhWzbEjwgbvZxw"]);
  });

  it("does not classify a burst of hits inside the span window", () => {
    const session = BeaconDetector.register().startRender();
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) {
      expect(session.record(BEACON, t0 + i * 100, STABLE)?.classified).toBe(
        false,
      );
    }
  });

  it("never classifies while the page is still changing, however long it fires", () => {
    const d = BeaconDetector.register();
    const session = d.startRender();
    const t0 = 1_000_000;
    // A page whose DOM keeps mutating is still building itself — its
    // requests must keep gating readiness no matter how they repeat.
    for (let i = 0; i < 20; i++) {
      expect(
        session.record(BEACON, t0 + i * 1_000, UNSTABLE)?.classified,
      ).toBe(false);
    }
    expect(d.isBeacon(BEACON)).toBe(false);
  });

  it("does not classify a query waterfall: one late fetch into a settled page", () => {
    const d = BeaconDetector.register();
    const session = d.startRender();
    const GQL = "https://site.com/graphql";
    const t0 = 1_000_000;
    // Two boot queries while the page is still painting...
    session.record(GQL, t0, UNSTABLE);
    session.record(GQL, t0 + 200, UNSTABLE);
    // ...then one lazy/dependent query into a settled page. hits=3 and the
    // span is satisfied, but only one hit is post-stable.
    const rec = session.record(GQL, t0 + 6_000, STABLE);
    expect(rec?.classified).toBe(false);
    expect(d.isBeacon(GQL)).toBe(false);
  });

  it("requires BEACON_MIN_POST_STABLE_HITS, not just one post-stable hit", () => {
    const d = BeaconDetector.register();
    const session = d.startRender();
    const t0 = 1_000_000;
    for (let i = 0; i < BEACON_MIN_POST_STABLE_HITS - 1; i++) {
      session.record(BEACON, t0 + i * 6_000, STABLE);
    }
    session.record(BEACON, t0 + 20_000, UNSTABLE);
    expect(d.isBeacon(BEACON)).toBe(false);
    expect(session.record(BEACON, t0 + 26_000, STABLE)?.classified).toBe(true);
  });

  it("never classifies a once-per-render data endpoint, however many renders run", () => {
    const d = BeaconDetector.register();
    const t0 = 1_000_000;
    for (let render = 0; render < 20; render++) {
      const rec = d
        .startRender()
        .record(
          "https://x.supabase.co/rest/v1/articles?select=*",
          t0 + render * 60_000,
          STABLE,
        );
      expect(rec?.classified).toBe(false);
    }
    expect(d.isBeacon("https://x.supabase.co/rest/v1/articles")).toBe(false);
  });

  it("shares a verdict job-wide: later renders see it from the first hit", () => {
    const d = BeaconDetector.register();
    const t0 = 1_000_000;
    const s1 = d.startRender();
    s1.record(BEACON, t0, STABLE);
    s1.record(BEACON, t0 + 3_000, STABLE);
    s1.record(BEACON, t0 + BEACON_MIN_SPAN_MS + 1, STABLE);
    const s2 = d.startRender();
    expect(s2.record(BEACON, t0 + 100_000, UNSTABLE)?.classified).toBe(true);
  });

  it("needs BEACON_MIN_HITS within the render even when the span has elapsed", () => {
    const session = BeaconDetector.register().startRender();
    const t0 = 1_000_000;
    for (let i = 1; i < BEACON_MIN_HITS; i++) {
      expect(session.record(BEACON, t0 + i * 60_000, STABLE)?.classified).toBe(
        false,
      );
    }
    expect(
      session.record(BEACON, t0 + BEACON_MIN_HITS * 60_000, STABLE)?.classified,
    ).toBe(true);
  });

  it("accumulates hits across query-string variants of one endpoint", () => {
    const session = BeaconDetector.register().startRender();
    const t0 = 1_000_000;
    session.record("https://bat.bing.com/action/0?ti=1", t0, STABLE);
    session.record("https://bat.bing.com/action/0?ti=2", t0 + 3_000, STABLE);
    const rec = session.record(
      "https://bat.bing.com/action/0?ti=3",
      t0 + 6_000,
      STABLE,
    );
    expect(rec?.newlyClassified).toBe(true);
  });

  it("caps per-render tracking without starving the next render", () => {
    const d = BeaconDetector.register();
    const t0 = 1_000_000;
    const s1 = d.startRender();
    for (let i = 0; i < 600; i++) {
      s1.record(`https://site.com/endpoint-${i}`, t0, STABLE);
    }
    const over = "https://site.com/endpoint-599";
    s1.record(over, t0 + 6_000, STABLE);
    s1.record(over, t0 + 12_000, STABLE);
    expect(d.isBeacon(over)).toBe(false);
    // The next render starts with a fresh map and classifies it.
    const s2 = d.startRender();
    s2.record(over, t0 + 20_000, STABLE);
    s2.record(over, t0 + 23_000, STABLE);
    s2.record(over, t0 + 20_000 + BEACON_MIN_SPAN_MS, STABLE);
    expect(d.isBeacon(over)).toBe(true);
  });
});
