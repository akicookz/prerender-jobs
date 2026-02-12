import { Logger, createLogger, transports } from "winston";

export class AppLogger {
  private constructor(
    private readonly _logger: Logger,
    private readonly _prefix: string,
  ) {}

  static register({ prefix }: { prefix: string }): AppLogger {
    return new AppLogger(
      createLogger({
        transports: [new transports.Console()],
      }),
      prefix,
    );
  }

  info(message: string, ...meta: unknown[]): void {
    this._logger.info(this.formatMessage(message), ...meta);
  }

  error(message: string, ...meta: unknown[]): void {
    this._logger.error(this.formatMessage(message), ...meta);
  }

  warn(message: string, ...meta: unknown[]): void {
    this._logger.warn(this.formatMessage(message), ...meta);
  }

  debug(message: string, ...meta: unknown[]): void {
    this._logger.debug(this.formatMessage(message), ...meta);
  }

  verbose(message: string, ...meta: unknown[]): void {
    this._logger.verbose(this.formatMessage(message), ...meta);
  }

  silly(message: string, ...meta: unknown[]): void {
    this._logger.silly(this.formatMessage(message), ...meta);
  }

  private formatMessage(message: string): string {
    return `[${this._prefix}] ${message}`;
  }
}
