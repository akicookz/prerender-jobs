import { Browser } from "puppeteer-core";
import { AppLogger } from "./logger";

/**
 * One browser per pipeline stream, owned for the stream's lifetime. Slots
 * relaunch on demand when a browser dies; callers recycle them periodically
 * so long runs don't accumulate Chromium memory bloat.
 */
export class BrowserPool {
  private readonly _slots: (Browser | null)[];
  private readonly _launch: () => Promise<Browser>;
  private readonly _logger: AppLogger;

  static register({
    size,
    launch,
    logger,
  }: {
    size: number;
    launch: () => Promise<Browser>;
    logger: AppLogger;
  }): BrowserPool {
    return new BrowserPool(size, launch, logger);
  }

  private constructor(
    size: number,
    launch: () => Promise<Browser>,
    logger: AppLogger,
  ) {
    this._slots = new Array<Browser | null>(size).fill(null);
    this._launch = launch;
    this._logger = logger;
  }

  /** Launch every slot up front so first renders don't pay launch latency. */
  async init(): Promise<void> {
    for (let slot = 0; slot < this._slots.length; slot++) {
      try {
        this._slots[slot] = await this._launch();
      } catch (e) {
        this._logger.error(
          `[Browser] Failed to launch browser for stream ${slot}`,
          e,
        );
        this._slots[slot] = null;
      }
    }
  }

  /** Return the slot's browser, relaunching if it died. Null when relaunch fails. */
  async ensureHealthy(slot: number): Promise<Browser | null> {
    const current = this._slots[slot];
    if (current && current.connected) {
      return current;
    }
    if (current) {
      await current.close().catch(() => {});
    }
    try {
      const fresh = await this._launch();
      this._slots[slot] = fresh;
      this._logger.info(`[Browser] Stream ${slot} browser refreshed`);
      return fresh;
    } catch (e) {
      this._logger.error(
        `[Browser] Failed to relaunch browser for stream ${slot}`,
        e,
      );
      this._slots[slot] = null;
      return null;
    }
  }

  /** Close the slot's browser so the next ensureHealthy launches a fresh one. */
  async recycle(slot: number): Promise<void> {
    const b = this._slots[slot];
    if (b) {
      await b.close().catch(() => {});
    }
    this._slots[slot] = null;
  }

  /** Drop a browser that died mid-render so the next render relaunches. */
  async dropIfDisconnected(slot: number): Promise<void> {
    const b = this._slots[slot];
    if (b && !b.connected) {
      await b.close().catch(() => {});
      this._slots[slot] = null;
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      this._slots.map((b) => (b ? b.close().catch(() => {}) : Promise.resolve())),
    );
  }
}
