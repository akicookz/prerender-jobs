import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import Cloudflare from "cloudflare";
import { AppLogger, INDENT } from "../logger";
import { KvRecord } from "./type";

interface CacheInvalidatorConfig {
  cfAccountId: string;
  cfApiToken: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  r2BucketName: string;
  kvNamespaceId: string;
}

export class CacheInvalidator {
  private readonly _cacheConfig: CacheInvalidatorConfig;
  private readonly _logger: AppLogger;

  static register({
    cacheConfig,
  }: {
    cacheConfig: CacheInvalidatorConfig;
  }): CacheInvalidator {
    return new CacheInvalidator(cacheConfig);
  }

  private constructor(cacheConfig: CacheInvalidatorConfig) {
    this._cacheConfig = cacheConfig;
    this._logger = AppLogger.register({ prefix: "cache-invalidator" });
  }
  private get cfClient(): Cloudflare {
    return new Cloudflare({
      apiToken: this._cacheConfig.cfApiToken,
    });
  }

  private get r2Client(): S3Client {
    return new S3Client({
      region: "auto",
      endpoint: `https://${this._cacheConfig.cfAccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: this._cacheConfig.r2AccessKeyId,
        secretAccessKey: this._cacheConfig.r2SecretAccessKey,
      },
    });
  }

  async invalidateMultipleStaleR2Objects({
    kvKeyObjectKeyMap,
  }: {
    kvKeyObjectKeyMap: Map<string, string>;
  }) {
    const { cfAccountId, kvNamespaceId } = this._cacheConfig;
    // Cloudflare KV bulk get API has a limit of 100 keys per request
    const batchSize = 100;
    const numberOfBatches = Math.ceil(kvKeyObjectKeyMap.size / batchSize);
    this._logger.info(
      `Invalidating stale R2 objects for ${kvKeyObjectKeyMap.size} keys in ${numberOfBatches} batches`,
    );
    const kvKeys = Array.from(kvKeyObjectKeyMap.keys());
    let batchNumber = 0;
    for (let i = 0; i < kvKeys.length; i += batchSize) {
      batchNumber++;
      this._logger.info(
        `Processing batch ${i / batchSize + 1} of ${numberOfBatches}`,
      );
      const batchKvKeys = kvKeys.slice(i, i + batchSize);
      let kvValues: { [key: string]: unknown } = {};
      try {
        const bulkGetResult = await this.cfClient.kv.namespaces.bulkGet(
          kvNamespaceId,
          {
            account_id: cfAccountId,
            keys: batchKvKeys,
          },
        );
        if (!bulkGetResult || !bulkGetResult.values) {
          this._logger.error(
            `${INDENT}↳ Batch ${batchNumber} - Failed to get KV records`,
          );
          continue;
        }
        kvValues = bulkGetResult.values;
      } catch (e) {
        this._logger.error(
          `${INDENT}↳ Batch ${batchNumber} - Failed to get KV records for invalidation`,
          e,
        );
        continue;
      }

      const objectsToDelete: string[] = [];
      batchKvKeys.forEach((kvKey) => {
        const kvValue = kvValues[kvKey];
        if (typeof kvValue !== "string") {
          return;
        }
        const objectKey = kvKeyObjectKeyMap.get(kvKey);
        if (!objectKey) {
          return;
        }
        let kvRecord: KvRecord;
        try {
          kvRecord = JSON.parse(kvValue) as KvRecord;
        } catch {
          return;
        }
        if (kvRecord.objectKey === objectKey) {
          return;
        }
        objectsToDelete.push(kvRecord.objectKey);
      });
      if (objectsToDelete.length) {
        const deleted = await this.deleteStaleR2Objects({
          objectKeys: objectsToDelete,
        });
        if (deleted) {
          this._logger.info(
            `${INDENT}↳ Batch ${batchNumber} - Invalidated ${objectsToDelete.length} stale R2 objects`,
          );
        } else {
          this._logger.error(
            `${INDENT}↳ Batch ${batchNumber} - Failed to invalidate ${objectsToDelete.length} stale R2 objects`,
          );
        }
      }
    }
  }

  private async deleteStaleR2Objects({
    objectKeys,
  }: {
    objectKeys: string[];
  }): Promise<boolean> {
    try {
      await this.r2Client.send(
        new DeleteObjectsCommand({
          Bucket: this._cacheConfig.r2BucketName,
          Delete: {
            Objects: objectKeys.map((objectKey) => ({
              Key: objectKey,
            })),
          },
        }),
      );
      return true;
    } catch (e) {
      this._logger.error(
        `${INDENT}${INDENT}↳ Failed to delete stale R2 objects`,
        e,
      );
      return false;
    }
  }
}
