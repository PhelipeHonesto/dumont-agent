/**
 * Structured logger (pino) for Dumont.
 *
 * - Writes to stderr (not stdout) so the MCP stdio server stays uncorrupted
 *   and CLI scripts can still print data tables to stdout cleanly.
 * - Pretty-printed in dev (TTY + non-production), JSON in prod.
 * - Level from LOG_LEVEL env var, default 'info'.
 * - Base fields: service, version, pid, hostname (pino adds pid/hostname).
 *
 * Usage:
 *   import { childLogger } from "../utils/logger.js";
 *   const log = childLogger("faa-daily-diff");
 *   log.info({ rows: 12345, duration_ms: 4200 }, "diff complete");
 *   log.error({ err, context: { date } }, "processing failed");
 */
import pino, { type Logger, type LoggerOptions } from "pino";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const isProd = process.env["NODE_ENV"] === "production";
const isTTY = process.stderr.isTTY === true;
const usePretty = !isProd && isTTY;

const baseOptions: LoggerOptions = {
  level: process.env["LOG_LEVEL"] ?? "info",
  base: {
    service: "osa-dumont",
    version: readVersion(),
  },
  ...(usePretty
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            destination: 2, // stderr
            translateTime: "SYS:HH:MM:ss.l",
            ignore: "pid,hostname,service,version",
            messageFormat: "{component} | {msg}",
          },
        },
      }
    : {}),
};

export const logger: Logger = usePretty
  ? pino(baseOptions)
  : pino(baseOptions, pino.destination({ dest: 2, sync: false }));

export function childLogger(component: string): Logger {
  return logger.child({ component });
}
