import { AppLogger } from "../logger";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

interface KvConfig {
  cfAccountId: string;
  cfApiToken: string;
  kvNamespaceId: string;
}

interface KvBulkUpdateResponse {
  success: boolean;
  errors: { code: number; message: string }[];
  result: {
    successful_key_count?: number;
    unsuccessful_keys?: string[];
  } | null;
}

export class KvLoader {
  private readonly _kvConfig: KvConfig;
  private readonly _logger: AppLogger;

  static register({ kvConfig }: { kvConfig: KvConfig }): KvLoader {
    return new KvLoader(kvConfig);
  }

  private constructor(kvConfig: KvConfig) {
    this._kvConfig = kvConfig;
    this._logger = AppLogger.register({ prefix: "kv-loader" });
  }

  async uploadKvRecords({
    kvPairs,
  }: {
    kvPairs: { key: string; value: string; expiration_ttl: number }[];
  }): Promise<{
    successfulKeyCount: number;
    unsuccessfulKeys: string[];
  }> {
    this._logger.info(`Uploading ${kvPairs.length} KV records to namespace`);
    const bulkUpdateUrl = `${CLOUDFLARE_API_BASE}/accounts/${this._kvConfig.cfAccountId}/storage/kv/namespaces/${this._kvConfig.kvNamespaceId}/bulk`;
    try {
      const res = await fetch(bulkUpdateUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${this._kvConfig.cfApiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(kvPairs),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(
          `KV bulk update returned ${res.status} ${res.statusText}: ${errBody}`,
        );
      }
      const json = (await res.json()) as KvBulkUpdateResponse;
      if (!json.success || json.result === null) {
        this._logger.error(
          `KV bulkUpdate unsuccessful — treating all ${kvPairs.length} keys as unsuccessful`,
          json.errors,
        );
        return {
          successfulKeyCount: 0,
          unsuccessfulKeys: kvPairs.map((pair) => pair.key),
        };
      }
      return {
        successfulKeyCount: json.result.successful_key_count ?? 0,
        unsuccessfulKeys: json.result.unsuccessful_keys ?? [],
      };
    } catch (e) {
      this._logger.error(`Failed to upload KV records — treating all ${kvPairs.length} keys as unsuccessful`, e);
      return {
        successfulKeyCount: 0,
        unsuccessfulKeys: kvPairs.map((pair) => pair.key),
      };
    }
  }
}
