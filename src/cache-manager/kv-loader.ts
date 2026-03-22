import Cloudflare from "cloudflare";
import { AppLogger } from "../logger";

interface KvConfig {
  cfAccountId: string;
  cfApiToken: string;
  kvNamespaceId: string;
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

  private get cfClient(): Cloudflare {
    return new Cloudflare({
      apiToken: this._kvConfig.cfApiToken,
    });
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
    try {
      const result = await this.cfClient.kv.namespaces.bulkUpdate(
        this._kvConfig.kvNamespaceId,
        {
          account_id: this._kvConfig.cfAccountId,
          body: kvPairs,
        },
      );
      if (result === null) {
        this._logger.error(`KV bulkUpdate returned null — treating all ${kvPairs.length} keys as unsuccessful`);
        return {
          successfulKeyCount: 0,
          unsuccessfulKeys: kvPairs.map((pair) => pair.key),
        };
      }
      return {
        successfulKeyCount: result.successful_key_count ?? 0,
        unsuccessfulKeys: result.unsuccessful_keys ?? [],
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
