import { CACHE_VERSION } from "./type";

const INTERNAL_PRERENDER_PARAM = "to_html";

// Tracking params never change page content, so ?utm_source=... variants must
// share one snapshot and one render instead of each minting a fresh cache
// entry. Only params with that universal contract belong here — anything a
// site might route content on (e.g. "ref", "page", "q") must stay.
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "ttclid",
  "twclid",
  "mc_cid",
  "mc_eid",
  "yclid",
  "_gl",
  "_ga",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

/**
 * Strip tracking params from a full URL string so render targets, KV record
 * URLs, and cache keys all agree on the canonical param-free form.
 * Content params are preserved. Returns the input unchanged if unparseable.
 */
export function stripTrackingParams(targetUrl: string): string {
  try {
    const u = new URL(targetUrl);
    let modified = false;
    for (const param of [...u.searchParams.keys()]) {
      if (isTrackingParam(param)) {
        u.searchParams.delete(param);
        modified = true;
      }
    }
    return modified ? u.toString() : targetUrl;
  } catch {
    return targetUrl;
  }
}

export function buildKvKey({ targetUrl }: { targetUrl: string }): string {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return "";
  }
  // Strip protocol and www, use only domain + path + query
  const hostname = url.hostname;
  const domain = normalizeDomain({ domain: hostname });
  const canonical = canonicalizePathForKey({ url });
  return `to_html:${CACHE_VERSION}:${domain}:${canonical}`;
}

export function normalizeDomain({ domain }: { domain: string }): string {
  const normalizedDomain = domain
    .toLowerCase()
    .trim()
    .replace(/^http(s)?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");

  const hasTrailingSlash = normalizedDomain.at(-1) === "/";

  if (hasTrailingSlash) {
    return normalizedDomain.slice(0, -1);
  }

  return normalizedDomain;
}

function canonicalizePathForKey({ url }: { url: URL }): string {
  const params: Array<[string, string]> = [];
  const omit = new Set([
    INTERNAL_PRERENDER_PARAM,
    "cache_invalidate",
    "to_html",
    "x-lovablehtml-render",
    "__lh_verify", // worker VERIFY_NONCE_PARAM — keep omit-sets identical
  ]);
  // Tracking params are also omitted at the key boundary so keys written by
  // this job match the serve-path keys computed from already-stripped URLs.
  for (const [k, v] of url.searchParams.entries()) {
    if (!omit.has(k) && !isTrackingParam(k)) params.push([k, v]);
  }
  params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const qs = params.map(([k, v]) => `${k}=${v}`).join("&");
  return `${url.pathname}${qs ? `?${qs}` : ""}`;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Single source for snapshot object-key derivation: hash of the canonical
 * KV-key string. The lovablehtml worker mirrors this in
 * worker/lib/prerender/prerender.ts deriveSnapshotObjectKey — keep in sync.
 * The host is normalized like buildKvKey's domain segment so www-preferred
 * domains land on the same key the worker derives.
 */
export async function buildSnapshotObjectKey({
  targetUrl,
}: {
  targetUrl: string;
}): Promise<string> {
  const url = new URL(targetUrl);
  const safeHost = normalizeDomain({ domain: url.hostname }).replace(
    /[^a-z0-9.-]/g,
    "-",
  );
  const safePath = url.pathname
    .replace(/^\//, "")
    .replace(/[^a-zA-Z0-9._/-]/g, "-")
    .replace(/\/+/, "/")
    .replace(/\//g, "_");
  const base = safePath || "root";
  const kvKeyDigest = await sha256Hex(buildKvKey({ targetUrl }));
  return `${CACHE_VERSION}/${safeHost}/${base}_${kvKeyDigest.slice(0, 16)}.html`;
}
