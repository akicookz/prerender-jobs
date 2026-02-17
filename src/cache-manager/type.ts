export interface CacheConfig {
  cacheTtl: number;
  cfAccountId: string;
  cfApiToken: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2BucketName: string;
  kvNamespaceId: string;
}

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
