import { CACHE_VERSION } from "./type";

const INTERNAL_PRERENDER_PARAM = "to_html";

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

function normalizeDomain({ domain }: { domain: string }): string {
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
  ]);
  for (const [k, v] of url.searchParams.entries()) {
    if (!omit.has(k)) params.push([k, v]);
  }
  params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const qs = params.map(([k, v]) => `${k}=${v}`).join("&");
  return `${url.pathname}${qs ? `?${qs}` : ""}`;
}
