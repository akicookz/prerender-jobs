export const PRERENDER_FAILURE_CODES = [
  "fetch_error",
  "too_many_redirects",
  "navigation_loop",
  "sync_failed",
  "unknown",
] as const;
export type PrerenderFailureCode = (typeof PRERENDER_FAILURE_CODES)[number];

export interface PrerenderFailureDetail {
  reason: PrerenderFailureCode;
  /** HTTP status of the main document — only set for fetch_error. */
  status?: number;
}

export interface PrerenderFailedPath {
  path: string;
  error: PrerenderFailureDetail;
}

export class RenderFailureError extends Error {
  readonly reason: PrerenderFailureCode;
  readonly status?: number;

  constructor(message: string, detail: PrerenderFailureDetail) {
    super(message);
    this.name = "RenderFailureError";
    this.reason = detail.reason;
    this.status = detail.status;
  }

  get detail(): PrerenderFailureDetail {
    if (this.status === undefined) return { reason: this.reason };
    return { reason: this.reason, status: this.status };
  }
}

export function toFailureDetail(e: unknown): PrerenderFailureDetail {
  if (e instanceof RenderFailureError) return e.detail;
  if (e instanceof Error && e.message.includes("ERR_TOO_MANY_REDIRECTS")) {
    return { reason: "too_many_redirects" };
  }
  return { reason: "unknown" };
}

export function countFailuresByReason(
  details: PrerenderFailureDetail[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const detail of details) {
    const key =
      detail.reason === "fetch_error" && detail.status !== undefined
        ? `fetch_error(${detail.status})`
        : detail.reason;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
