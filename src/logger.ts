import { Logger, createLogger, transports, format } from "winston";

export const INDENT = "  ";

// One shared winston logger for the whole process: AppLogger instances are
// cheap prefix wrappers, so per-render registrations (RenderEngine, R2Loader)
// don't allocate a new Console transport each time.
const baseLogger: Logger = createLogger({
  transports: [new transports.Console()],
  level: process.env.LOG_LEVEL || "info",
  format: process.env.LOG_LEVEL === "debug" ? format.simple() : format.json(),
});

export class AppLogger {
  private constructor(private readonly _prefix: string) {}

  static register({ prefix }: { prefix: string }): AppLogger {
    return new AppLogger(prefix);
  }

  info(message: string, ...meta: unknown[]): void {
    baseLogger.info(this.formatMessage(message), ...meta);
  }

  error(message: string, ...meta: unknown[]): void {
    baseLogger.error(this.formatMessage(message), ...meta);
  }

  warn(message: string, ...meta: unknown[]): void {
    baseLogger.warn(this.formatMessage(message), ...meta);
  }

  debug(message: string, ...meta: unknown[]): void {
    baseLogger.debug(this.formatMessage(message), ...meta);
  }

  verbose(message: string, ...meta: unknown[]): void {
    baseLogger.verbose(this.formatMessage(message), ...meta);
  }

  silly(message: string, ...meta: unknown[]): void {
    baseLogger.silly(this.formatMessage(message), ...meta);
  }

  private formatMessage(message: string): string {
    return `[${this._prefix}] ${message}`;
  }
}
