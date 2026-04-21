// Named-pipe IPC server. On Windows listens on `\\.\pipe\ft5-sync[-dev]`;
// on Unix listens on a filesystem socket inside the data dir with mode
// 0600. One bidirectional connection per client; the server writes
// responses (correlated by id) AND unsolicited event frames on the same
// stream.
//
// Handlers are async and may overlap — each request starts its handler
// immediately; responses may arrive out of order (correlation is by id).

import * as fsp from "node:fs/promises";
import * as net from "node:net";

import type {
  COMMAND_NAMES,
  CommandError,
  CommandName,
  CommandParams,
  CommandResult,
  ErrorShape,
  EventFrame,
  RequestFrame,
  ResponseFrame,
} from "@ft5/ipc-contracts/sync-service";

import { FramingDecoder, encodeFrame } from "./framing.js";

export type CommandHandler<N extends CommandName> = (
  params: CommandParams<N>,
  ctx: { readonly connection: Connection },
) => Promise<
  | { readonly ok: true; readonly result: CommandResult<N> }
  | { readonly ok: false; readonly error: CommandError<N> }
>;

export type CommandHandlers = {
  [N in CommandName]?: CommandHandler<N>;
};

export interface Connection {
  /** Write an unsolicited event frame on this connection. Safe to call
   *  even if the connection has already been closed — errors are swallowed. */
  sendEvent(event: Omit<EventFrame, "kind">): void;
  readonly id: number;
  readonly closed: boolean;
}

export interface StartServerOptions {
  readonly pipePath: string;
  readonly handlers: CommandHandlers;
  readonly commandNames: typeof COMMAND_NAMES;
}

export interface RunningServer {
  readonly pipePath: string;
  close(): Promise<void>;
  /** Broadcast an event to every connected client. Safe to call any time. */
  broadcast(event: Omit<EventFrame, "kind">): void;
  /** Observable list of currently-connected client ids (read-only). */
  connections(): ReadonlyArray<Connection>;
}

let nextConnectionId = 1;

export async function startServer(
  options: StartServerOptions,
): Promise<RunningServer> {
  // On Unix, unlink any leftover socket from a prior crashed instance so
  // listen() doesn't fail with EADDRINUSE. On Windows (named pipe) this is
  // a no-op — the OS cleans up the pipe when the owning process exits.
  if (process.platform !== "win32") {
    try {
      await fsp.unlink(options.pipePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  const active = new Set<ConnectionImpl>();
  const commandSet = new Set<string>(options.commandNames);

  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    const conn = new ConnectionImpl(socket, options.handlers, commandSet);
    active.add(conn);
    socket.once("close", () => {
      active.delete(conn);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.pipePath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  // Tighten the Unix socket's permissions after listen() so nobody else on
  // the host can connect even if the data dir is misconfigured. On Windows
  // the named pipe ACL is applied by the pipe creation itself.
  if (process.platform !== "win32") {
    try {
      await fsp.chmod(options.pipePath, 0o600);
    } catch {
      /* tolerated — still secured by the data dir's 0o700 mode */
    }
  }

  return {
    pipePath: options.pipePath,
    async close() {
      for (const conn of active) conn.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
    broadcast(event) {
      for (const conn of active) conn.sendEvent(event);
    },
    connections() {
      return Array.from(active);
    },
  };
}

class ConnectionImpl implements Connection {
  readonly id: number;
  closed = false;
  private readonly socket: net.Socket;
  private readonly decoder: FramingDecoder;
  private readonly handlers: CommandHandlers;
  private readonly commandSet: Set<string>;

  constructor(
    socket: net.Socket,
    handlers: CommandHandlers,
    commandSet: Set<string>,
  ) {
    this.id = nextConnectionId++;
    this.socket = socket;
    this.handlers = handlers;
    this.commandSet = commandSet;

    this.decoder = new FramingDecoder({
      onFrame: (frame) => void this.handleFrame(frame).catch(() => void 0),
      onError: (err) => this.sendParseError(err.message),
    });

    socket.on("data", (chunk) => this.decoder.push(chunk));
    socket.on("close", () => {
      this.closed = true;
    });
    socket.on("error", () => {
      this.closed = true;
      try {
        socket.destroy();
      } catch {
        /* tolerated */
      }
    });
  }

  destroy(): void {
    try {
      this.socket.destroy();
    } catch {
      /* tolerated */
    }
  }

  sendEvent(event: Omit<EventFrame, "kind">): void {
    this.writeFrame({ kind: "event", name: event.name, payload: event.payload });
  }

  private async handleFrame(frame: unknown): Promise<void> {
    const req = frame as RequestFrame;
    if (!isRequest(req)) return; // responses/events on inbound stream are ignored

    if (!this.commandSet.has(req.command)) {
      this.sendResponse({
        id: req.id,
        kind: "response",
        ok: false,
        error: {
          tag: "unknown-command",
          message: `unknown command: ${req.command}`,
        } as ErrorShape,
      });
      return;
    }

    const handler = this.handlers[req.command as CommandName] as
      | CommandHandler<CommandName>
      | undefined;
    if (!handler) {
      this.sendResponse({
        id: req.id,
        kind: "response",
        ok: false,
        error: {
          tag: "internal-error",
          message: `no handler registered for ${req.command}`,
        } as ErrorShape,
      });
      return;
    }

    try {
      const res = await handler(
        req.params as CommandParams<CommandName>,
        { connection: this },
      );
      if (res.ok) {
        this.sendResponse({
          id: req.id,
          kind: "response",
          ok: true,
          result: res.result,
        });
      } else {
        this.sendResponse({
          id: req.id,
          kind: "response",
          ok: false,
          error: res.error as ErrorShape,
        });
      }
    } catch (err) {
      this.sendResponse({
        id: req.id,
        kind: "response",
        ok: false,
        error: {
          tag: "internal-error",
          message: (err as { message?: string }).message ?? "unknown",
        } as ErrorShape,
      });
    }
  }

  private sendParseError(message: string): void {
    // Without an id we can't correlate; send an event frame for
    // diagnostic visibility, then carry on.
    this.writeFrame({
      kind: "event",
      name: "ipc-parse-error",
      payload: { message },
    });
  }

  private sendResponse(frame: ResponseFrame): void {
    this.writeFrame(frame);
  }

  private writeFrame(frame: RequestFrame | ResponseFrame | EventFrame): void {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(frame));
    } catch {
      this.closed = true;
    }
  }
}

function isRequest(v: unknown): v is RequestFrame {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    r["kind"] === "request" &&
    typeof r["id"] === "string" &&
    typeof r["command"] === "string"
  );
}
