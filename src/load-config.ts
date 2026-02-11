import dotenv from "dotenv";
import { isMemberOfEnum } from "./util.js";
import validator from "validator";

const DEFAULT_CACHE_TTL = 604800; // 7 days

export enum LastmodFilter {
  ONE_DAY = "1d",
  THREE_DAYS = "3d",
  SEVEN_DAYS = "7d",
  THIRTY_DAYS = "30d",
  ALL = "all",
}

enum ConfigEnvVariables {
  // REQUIRED
  URL_LIST = "URL_LIST",
  CF_ACCOUNT_ID = "CF_ACCOUNT_ID",
  CF_API_TOKEN = "CF_API_TOKEN",
  R2_ACCESS_KEY_ID = "R2_ACCESS_KEY_ID",
  R2_SECRET_ACCESS_KEY = "R2_SECRET_ACCESS_KEY",
  R2_BUCKET_NAME = "R2_BUCKET_NAME",
  KV_NAMESPACE_ID = "KV_NAMESPACE_ID",

  // OPTIONAL
  CONCURRENCY = "CONCURRENCY",
  WEBHOOK_URL = "WEBHOOK_URL",
  SITEMAP_URL = "SITEMAP_URL",
  SITEMAP_UPDATED_WITHIN = "SITEMAP_UPDATED_WITHIN",
  CACHE_TTL = "CACHE_TTL",
  USER_AGENT = "USER_AGENT",
}

export interface Configuration {
  // CSV of URLs
  urlList: string[];
  // Callback URL on completion
  webhookUrl: string | undefined;
  // Explicit sitemap URL
  sitemapUrl: string | undefined;
  // Filter by lastmod
  sitemapUpdatedWithin: LastmodFilter;
  // Cloudflare account ID
  cfAccountId: string;
  // API token for KV
  cfApiToken: string;
  // R2 S3 key ID
  r2AccessKeyId: string;
  // R2 S3 secret
  r2SecretAccessKey: string;
  // R2 bucket
  r2BucketName: string;
  // KV namespace ID
  kvNamespaceId: string;
  // TTL in seconds
  cacheTtl: number;
  // User agent
  userAgent: string | undefined;
  // Concurrency
  concurrency: number;
}

export function loadConfig(): Configuration {
  const isDevelopment = process.env.NODE_ENV === "development";
  if (isDevelopment) {
    dotenv.config({
      path: ".env.local",
    });
  }

  // URL list is required
  const urlListRaw = process.env[ConfigEnvVariables.URL_LIST] ?? "";
  const urlList = urlListRaw.split(",").map((item) => item.trim());
  if (urlList.length === 0) {
    throw new Error("URL_LIST is required and must be a non-empty CSV");
  }
  if (urlList.some((url) => !validator.isURL(url))) {
    throw new Error("URL_LIST must be a list of URLs starting with https://");
  }

  // Webhook URL and sitemap configuration are optional
  const webhookUrl = process.env[ConfigEnvVariables.WEBHOOK_URL];
  const sitemapUrl = process.env[ConfigEnvVariables.SITEMAP_URL];

  const sitemapUpdatedWithin =
    process.env[ConfigEnvVariables.SITEMAP_UPDATED_WITHIN] || LastmodFilter.ALL;
  if (!isMemberOfEnum(LastmodFilter, sitemapUpdatedWithin)) {
    throw new Error(
      "SITEMAP_UPDATED_WITHIN must be one of: " +
        Object.values(LastmodFilter).join(", "),
    );
  }
  // Cloudflare credentials and cache configuration are required
  const cfAccountId = process.env[ConfigEnvVariables.CF_ACCOUNT_ID];
  if (!cfAccountId) {
    throw new Error("CF_ACCOUNT_ID is required");
  }
  const cfApiToken = process.env[ConfigEnvVariables.CF_API_TOKEN];
  if (!cfApiToken) {
    throw new Error("CF_API_TOKEN is required");
  }
  const r2AccessKeyId = process.env[ConfigEnvVariables.R2_ACCESS_KEY_ID];
  if (!r2AccessKeyId) {
    throw new Error("R2_ACCESS_KEY_ID is required");
  }
  const r2SecretAccessKey =
    process.env[ConfigEnvVariables.R2_SECRET_ACCESS_KEY];
  if (!r2SecretAccessKey) {
    throw new Error("R2_SECRET_ACCESS_KEY is required");
  }
  const r2BucketName = process.env[ConfigEnvVariables.R2_BUCKET_NAME];
  if (!r2BucketName) {
    throw new Error("R2_BUCKET_NAME is required");
  }
  const kvNamespaceId = process.env[ConfigEnvVariables.KV_NAMESPACE_ID];
  if (!kvNamespaceId) {
    throw new Error("KV_NAMESPACE_ID is required");
  }

  // Cache TTL is optional, default to 7 days if not set
  const cacheTtlRaw = process.env[ConfigEnvVariables.CACHE_TTL];
  let cacheTtl: number = DEFAULT_CACHE_TTL;
  if (cacheTtlRaw && !Number.isNaN(parseInt(cacheTtlRaw))) {
    cacheTtl = parseInt(cacheTtlRaw);
  }

  // User agent is optional, default to default user agent if not set
  const userAgent = process.env[ConfigEnvVariables.USER_AGENT];

  // Concurrency is optional, default to 1 if not set
  const concurrencyRaw = process.env[ConfigEnvVariables.CONCURRENCY];
  let concurrency: number = 1;
  if (concurrencyRaw && !Number.isNaN(parseInt(concurrencyRaw))) {
    concurrency = parseInt(concurrencyRaw);
  }
  if (concurrency < 1) {
    throw new Error("CONCURRENCY must be at least 1");
  }

  return {
    urlList,
    webhookUrl,
    sitemapUrl,
    sitemapUpdatedWithin,
    cfAccountId,
    cfApiToken,
    r2AccessKeyId,
    r2SecretAccessKey,
    r2BucketName,
    kvNamespaceId,
    cacheTtl,
    userAgent,
    concurrency,
  };
}
