// Minimal structured logger. JSON lines to a rotating file (5 MB × 5
// files). Rotation hand-rolled — no new dependency. LOG_LEVEL gating
// respects env override. Intended seam: pass the logger into other
// modules' deps, not a global import.
//
// Spec: "Observability" (design.md D20).

import * as fs from "node:fs";
import * as path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LoggerOptions {
  readonly filePath: string;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly level?: LogLevel;
}

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  close(): void;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

export function createLogger(options: LoggerOptions): Logger {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const level =
    options.level ??
    ((process.env["LOG_LEVEL"] as LogLevel | undefined) ?? "info");

  let bytesWritten = (() => {
    try {
      return fs.statSync(options.filePath).size;
    } catch {
      return 0;
    }
  })();

  fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
  let handle = fs.openSync(options.filePath, "a");

  function rotate(): void {
    try {
      fs.closeSync(handle);
    } catch {
      /* tolerated */
    }
    for (let i = maxFiles - 1; i >= 1; i--) {
      const src = `${options.filePath}.${i}`;
      const dst = `${options.filePath}.${i + 1}`;
      if (fs.existsSync(src)) {
        try {
          fs.renameSync(src, dst);
        } catch {
          /* tolerated */
        }
      }
    }
    try {
      fs.renameSync(options.filePath, `${options.filePath}.1`);
    } catch {
      /* tolerated */
    }
    // Drop the oldest file if it still exists (we overshot the count).
    const overflow = `${options.filePath}.${maxFiles + 1}`;
    if (fs.existsSync(overflow)) {
      try {
        fs.unlinkSync(overflow);
      } catch {
        /* tolerated */
      }
    }
    handle = fs.openSync(options.filePath, "a");
    bytesWritten = 0;
  }

  function write(line: string): void {
    const buf = Buffer.from(line, "utf8");
    if (bytesWritten + buf.length > maxBytes) rotate();
    fs.writeSync(handle, buf);
    bytesWritten += buf.length;
  }

  function emit(lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const rec: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...(fields ?? {}),
    };
    write(`${JSON.stringify(rec)}\n`);
  }

  return {
    log: emit,
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    close() {
      try {
        fs.closeSync(handle);
      } catch {
        /* tolerated */
      }
    },
  };
}

/**
 * Redact secret-bearing param blocks on an IPC command. Called by the
 * audit middleware before logging `sync:authenticate` params.
 *
 * The split `sync:authenticate-start` / `sync:authenticate-complete`
 * channels are also redacted: the stubbed handlers never see real
 * tokens today, but the defensive rule must land with the channel
 * names so the follow-up `implement-datasource-onboarding` change
 * cannot accidentally log credentials (see design.md Decision 11).
 * The old `sync:authenticate` channel stays redacted until it is
 * removed in 5.A.14.
 */
export function redactCommandParams(
  command: string,
  params: unknown,
): unknown {
  if (
    command === "sync:authenticate" ||
    command === "sync:authenticate-start" ||
    command === "sync:authenticate-complete"
  ) {
    return "[redacted]";
  }
  return params;
}
