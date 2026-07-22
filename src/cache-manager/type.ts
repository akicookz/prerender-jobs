export const CACHE_VERSION = "v1"; // bump to invalidate KV mapping semantics

export interface KvRecord {
  url: string;
  objectKey: string;
  digest: string;
  createdAt: string;
  contentType: string;
  contentLength: number;
  cacheVersion: string;
  userAgent: string | null;
  accept: string | null;
}
