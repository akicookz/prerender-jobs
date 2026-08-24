// Static known-telemetry lists, split out of RenderEngine so the
// BeaconDetector can report whether a behaviorally-classified endpoint was
// already covered here. The detector is what stops the lists from having to
// GROW (it catches unknown/first-party beacons on its own), but note the
// tradeoff before deleting entries: detector state is per-job, so a
// delisted endpoint re-pays a few seconds of idle-gating at the start of
// every job until it re-classifies. Keep list entries for widespread
// offenders; delete only ones the classification logs show never fire.

// Domains to ignore for network idle detection (analytics, fonts, ads)
const ignoredHosts = [
  "google.com",
  "google.co.uk",
  "google-analytics.com",
  "googletagmanager.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "fonts.reown.com",
  "www.googletagmanager.com",
  "analytics.google.com",
  "facebook.com",
  "www.facebook.com",
  "connect.facebook.net",
  "brilliantlocco.com",
  "doubleclick.net",
  "googlesyndication.com",
  "hotjar.com",
  "hotjar.io",
  "clarity.ms",
  "segment.io",
  "segment.com",
  "mixpanel.com",
  "amplitude.com",
  "posthog.com",
  "intercom.io",
  "crisp.chat",
  "sentry.io",
  "tawk.to",
  "drift.com",
  "zendesk.com",
  "hubspot.com",
  "hs-analytics.net",
  "hs-scripts.com",
  "freshdesk.com",
  "livechatinc.com",
  "fullstory.com",
  "heap.io",
  "heapanalytics.com",
  "logrocket.com",
  "mouseflow.com",
  "optimizely.com",
  "cloudflareinsights.com",
  "radar.snitcher.com",
  "liadm.com",
  "js.zi-scripts.com",
  "ads.linkedin.com",
  "kular.ai",
  "mapbox.com",
  "chatwhisperer.ai",
  // Turnstile challenge polling can run for many seconds and never
  // contributes snapshot content.
  "challenges.cloudflare.com",
  "pndsn.com",
];

export function isIgnoredHost(host: string): boolean {
  return ignoredHosts.some((h) => host === h || host.endsWith(`.${h}`));
}

// Telemetry that must not gate the snapshot: a repeatedly-firing beacon
// resets the network-idle clock and rides every render to the hard
// timeout. The requests still load normally. ~flock.js and /__l5e/
// (events.js, trackevents) are Lovable's injected analytics;
// track_growth_event is Lovable's growth-telemetry Supabase RPC (fetch/xhr
// are tracked regardless of host, so a host rule can't catch it).
const ignoredPaths = [
  "fb-conversions-api",
  "~flock.js",
  "__l5e/",
  "track_growth_event",
];

export function isIgnoredPath(path: string): boolean {
  return ignoredPaths.some((p) => path.includes(p));
}
