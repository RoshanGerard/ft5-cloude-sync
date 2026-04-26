// End-to-end integration tests for the three-command authenticate split
// — implement-datasource-onboarding §14.3 + §14.4. Boots a real service
// runtime against a scratch dataDir, drives both authenticate paths
// (OAuth start+cancel for `google-drive`; credentials-form start+complete
// for `amazon-s3`) through a real IPC client, and asserts the on-the-wire
// response shape, the bus event sequence, and (for credentials-form) the
// on-disk credential entry.
//
// Setup pattern follows `services/fs-sync/src/main/signals.test.ts`:
//   * scratch dir via mkdtemp
//   * synthetic service config seeded BEFORE bootstrap so
//     `getOAuthAppConfig` resolves for google-drive without touching
//     real network endpoints
//   * full `bootstrap()` (NOT manually wired handlers) so the §14
//     bootstrap stages we're really validating actually fire
//   * real IPC client via raw `net.Socket` + `FramingDecoder`
//   * `sync:subscribe-events` to capture bus events on the wire (the
//     Runtime handle does not expose the bus directly)
//
// `intent.completeWith(code)` (Google) is NEVER reached — the §14.3 arm
// only exercises start + cancel, both of which run before any token
// exchange. The §14.4 arm (S3 credentials-form) DOES need to stub the
// AWS SDK because `intent.submit(values)` calls `HeadBucket`. We use
// `vi.mock("@aws-sdk/client-s3", ...)` at module level to swap the
// SDK; vitest hoists the mock so the engine's `s3-client.ts` resolves
// the stub at import time. No service-package devDep addition needed.

import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FramingDecoder } from "../ipc/framing.js";
import { bootstrap, type Runtime } from "../main/bootstrap.js";

// ---------------------------------------------------------------------------
// AWS SDK module-level mock for the §14.4 credentials-form arm
// ---------------------------------------------------------------------------
// Vitest hoists this above the imports above so when the engine's
// `strategies/s3-client.ts` resolves `@aws-sdk/client-s3`, it gets the
// stubbed classes. The stubs return `{}` for every command (HeadBucket
// success path) which is enough for the `intent.submit(values)` happy
// path to resolve without touching real AWS.
vi.mock("@aws-sdk/client-s3", () => {
  class FakeS3Client {
    send = vi.fn(async () => ({}));
    destroy = vi.fn();
  }
  // Each Command class just stores the input — the real SDK middleware
  // chain is gone, so the strategy's `aws.send(new Cmd(input))` call
  // path becomes `fakeClient.send(input)` and resolves to `{}`.
  class CommandStub {
    constructor(public readonly input: unknown) {}
  }
  return {
    S3Client: FakeS3Client,
    HeadBucketCommand: CommandStub,
    HeadObjectCommand: CommandStub,
    ListObjectsV2Command: CommandStub,
    GetObjectCommand: CommandStub,
    PutObjectCommand: CommandStub,
    DeleteObjectCommand: CommandStub,
    CopyObjectCommand: CommandStub,
    CreateMultipartUploadCommand: CommandStub,
    UploadPartCommand: CommandStub,
    CompleteMultipartUploadCommand: CommandStub,
    AbortMultipartUploadCommand: CommandStub,
  };
});

// ---------------------------------------------------------------------------
// IPC client helpers (mirrors signals.test.ts, kept self-contained)
// ---------------------------------------------------------------------------

interface ResponseFrame {
  readonly kind: "response";
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { tag: string; message: string };
}

interface EventFrame {
  readonly kind: "event";
  readonly name: string;
  readonly payload: unknown;
}

function pipeFor(tag: string): string {
  const suffix =
    `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\ft5-sync-int-auth-${tag}-${suffix}`;
  }
  return path.join(os.tmpdir(), `ft5-sync-int-auth-${tag}-${suffix}.sock`);
}

async function connect(pipePath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(pipePath);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

interface Client {
  readonly socket: net.Socket;
  send(frame: {
    id: string;
    kind: "request";
    command: string;
    params: unknown;
  }): void;
  waitForResponse(id: string, timeoutMs?: number): Promise<ResponseFrame>;
  waitForEvent(name: string, timeoutMs?: number): Promise<EventFrame>;
  countEvents(name: string): number;
  close(): void;
}

function makeClient(socket: net.Socket): Client {
  const responses = new Map<string, ResponseFrame>();
  const events: EventFrame[] = [];
  const decoder = new FramingDecoder({
    onFrame: (f) => {
      const frame = f as { kind?: string };
      if (frame.kind === "response") {
        const r = f as ResponseFrame;
        responses.set(r.id, r);
      } else if (frame.kind === "event") {
        events.push(f as EventFrame);
      }
    },
    onError: () => void 0,
  });
  socket.on("data", (chunk) => decoder.push(chunk));
  return {
    socket,
    send(frame) {
      socket.write(`${JSON.stringify(frame)}\n`);
    },
    async waitForResponse(id, timeoutMs = 5000) {
      const t0 = Date.now();
      while (!responses.has(id)) {
        if (Date.now() - t0 > timeoutMs) {
          throw new Error(`timeout waiting for response id=${id}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return responses.get(id)!;
    },
    async waitForEvent(name, timeoutMs = 5000) {
      const t0 = Date.now();
      while (true) {
        const e = events.find((ev) => ev.name === name);
        if (e) return e;
        if (Date.now() - t0 > timeoutMs) {
          throw new Error(`timeout waiting for event name=${name}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    countEvents(name) {
      return events.filter((e) => e.name === name).length;
    },
    close() {
      socket.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Per-test scratch dir + runtime lifecycle
// ---------------------------------------------------------------------------

let scratchDir: string;
let runtime: Runtime | null = null;

async function bootScratchRuntime(opts: {
  socketPath: string;
  /** When provided, written to `<scratchDir>/config.json` BEFORE bootstrap. */
  serviceConfig?: unknown;
}): Promise<Runtime> {
  const configPath = path.join(scratchDir, "config.json");
  if (opts.serviceConfig !== undefined) {
    await fsp.writeFile(
      configPath,
      JSON.stringify(opts.serviceConfig),
      { mode: 0o600 },
    );
  }
  return bootstrap({
    dev: true,
    dataDir: scratchDir,
    pidPath: path.join(scratchDir, "service-dev.pid"),
    dbPath: path.join(scratchDir, "sync.db"),
    socketPath: opts.socketPath,
    credentialsPath: path.join(scratchDir, "credentials.json"),
    configPath,
  });
}

beforeEach(async () => {
  scratchDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "ft5-sync-int-auth-"),
  );
  runtime = null;
});

afterEach(async () => {
  try {
    if (runtime) {
      try {
        await runtime.stop();
      } catch {
        /* tolerated */
      }
    }
  } finally {
    runtime = null;
    try {
      await fsp.rm(scratchDir, { recursive: true, force: true });
    } catch {
      /* tolerated */
    }
  }
});

// ---------------------------------------------------------------------------
// §14.3 — OAuth start + cancel round-trip
// ---------------------------------------------------------------------------

describe("authenticate flow integration — OAuth (google-drive) start+cancel", () => {
  it(
    "start returns kind=oauth, bus emits auth-initiated + oauth-open-url, cancel returns cancelled=true and emits auth-cancelled",
    async () => {
      const pipePath = pipeFor("oauth");
      runtime = await bootScratchRuntime({
        socketPath: pipePath,
        serviceConfig: {
          schemaVersion: 1,
          providers: {
            "google-drive": {
              clientId: "synthetic-client-id",
              clientSecret: "synthetic-client-secret",
            },
          },
        },
      });

      const sock = await connect(pipePath);
      const cli = makeClient(sock);

      try {
        // 1. Subscribe to the event stream BEFORE issuing the start so we
        //    see auth-initiated + oauth-open-url.
        cli.send({
          id: "sub",
          kind: "request",
          command: "sync:subscribe-events",
          params: {},
        });
        const subRes = await cli.waitForResponse("sub");
        expect(subRes.ok).toBe(true);

        // 2. Start the OAuth authenticate flow.
        cli.send({
          id: "start",
          kind: "request",
          command: "sync:authenticate-start",
          params: { providerId: "google-drive" },
        });
        const startRes = await cli.waitForResponse("start");
        expect(startRes.ok).toBe(true);
        if (!startRes.ok) return;
        const result = startRes.result as {
          correlationId: string;
          kind: "oauth";
        };
        expect(result.kind).toBe("oauth");
        expect(typeof result.correlationId).toBe("string");
        expect(result.correlationId.length).toBeGreaterThan(0);
        const correlationId = result.correlationId;

        // 3. The bus emits auth-initiated then oauth-open-url, both keyed
        //    on the same correlationId. Wait for both.
        const initiated = await cli.waitForEvent("auth-initiated");
        const openUrl = await cli.waitForEvent("oauth-open-url");
        expect((initiated.payload as { correlationId: string }).correlationId)
          .toBe(correlationId);
        expect((initiated.payload as { providerId: string }).providerId)
          .toBe("google-drive");
        expect((openUrl.payload as { correlationId: string }).correlationId)
          .toBe(correlationId);
        const authorizeUrl =
          (openUrl.payload as { authorizeUrl: string }).authorizeUrl;
        expect(typeof authorizeUrl).toBe("string");
        expect(authorizeUrl).toMatch(/^https:\/\//);
        // The redirect_uri in the URL must point at our loopback port.
        const parsed = new URL(authorizeUrl);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

        // 4. Cancel — broker.cancel runs, broker emits auth-cancelled,
        //    handler returns cancelled=true.
        cli.send({
          id: "cancel",
          kind: "request",
          command: "sync:authenticate-cancel",
          params: { correlationId },
        });
        const cancelRes = await cli.waitForResponse("cancel");
        expect(cancelRes.ok).toBe(true);
        if (!cancelRes.ok) return;
        expect((cancelRes.result as { cancelled: boolean }).cancelled).toBe(
          true,
        );

        // 5. auth-cancelled fires once.
        const cancelled = await cli.waitForEvent("auth-cancelled");
        expect((cancelled.payload as { correlationId: string }).correlationId)
          .toBe(correlationId);
        expect(cli.countEvents("auth-cancelled")).toBe(1);
      } finally {
        cli.close();
      }
    },
    15_000,
  );

  it(
    "start with absent service config returns service-config-missing; emits no event",
    async () => {
      const pipePath = pipeFor("oauth-missing");
      // Do NOT seed config.json — this exercises the spec scenario
      // "Service-config-missing on OAuth start: no event is emitted, no
      // loopback server is bound".
      runtime = await bootScratchRuntime({ socketPath: pipePath });

      const sock = await connect(pipePath);
      const cli = makeClient(sock);

      try {
        cli.send({
          id: "sub",
          kind: "request",
          command: "sync:subscribe-events",
          params: {},
        });
        await cli.waitForResponse("sub");

        cli.send({
          id: "start",
          kind: "request",
          command: "sync:authenticate-start",
          params: { providerId: "google-drive" },
        });
        const res = await cli.waitForResponse("start");
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.error.tag).toBe("service-config-missing");

        // No event should fire — wait briefly to be sure none arrives.
        await new Promise((r) => setTimeout(r, 100));
        expect(cli.countEvents("auth-initiated")).toBe(0);
        expect(cli.countEvents("oauth-open-url")).toBe(0);
        expect(cli.countEvents("auth-failed")).toBe(0);
      } finally {
        cli.close();
      }
    },
    10_000,
  );
});

// ---------------------------------------------------------------------------
// §14.4 — credentials-form start + complete (amazon-s3)
// ---------------------------------------------------------------------------

describe("authenticate flow integration — credentials-form (amazon-s3) start+complete", () => {
  it(
    "start returns kind=credentials-form with formSchema; complete writes credentials and emits credential-persisted + auth-completed",
    async () => {
      const pipePath = pipeFor("creds-form");
      // S3 does not consult the OAuth app config — but bootstrapping with
      // an empty config dir is still fine (the configStore is constructed
      // lazily-readable). We do NOT seed config.json here.
      runtime = await bootScratchRuntime({ socketPath: pipePath });

      const sock = await connect(pipePath);
      const cli = makeClient(sock);

      try {
        cli.send({
          id: "sub",
          kind: "request",
          command: "sync:subscribe-events",
          params: {},
        });
        await cli.waitForResponse("sub");

        // 1. Start.
        cli.send({
          id: "start",
          kind: "request",
          command: "sync:authenticate-start",
          params: { providerId: "amazon-s3" },
        });
        const startRes = await cli.waitForResponse("start");
        expect(startRes.ok).toBe(true);
        if (!startRes.ok) return;
        const startResult = startRes.result as {
          correlationId: string;
          kind: "credentials-form";
          formSchema: string;
        };
        expect(startResult.kind).toBe("credentials-form");
        expect(typeof startResult.correlationId).toBe("string");
        expect(startResult.formSchema).toBe("aws-access-key");
        const correlationId = startResult.correlationId;

        // auth-initiated emits on credentials-form path (handler-driven).
        const initiated = await cli.waitForEvent("auth-initiated");
        expect((initiated.payload as { correlationId: string }).correlationId)
          .toBe(correlationId);

        // 2. Complete with synthetic AWS values. The mocked
        //    `@aws-sdk/client-s3` makes the strategy's HeadBucket
        //    verification a no-op resolve.
        cli.send({
          id: "complete",
          kind: "request",
          command: "sync:authenticate-complete",
          params: {
            correlationId,
            completion: {
              kind: "credentials-form",
              values: {
                accessKeyId: "AKIATESTFAKEFAKE",
                secretAccessKey: "fake-secret-fake-secret-fake-secret",
                region: "us-east-1",
                bucket: "test-bucket-int",
              },
            },
          },
        });
        const completeRes = await cli.waitForResponse("complete");
        expect(completeRes.ok).toBe(true);
        if (!completeRes.ok) return;
        const completeResult = completeRes.result as {
          datasourceId: string;
          summary: { id: string; providerId: string; status: string };
        };
        expect(typeof completeResult.datasourceId).toBe("string");
        expect(completeResult.datasourceId.length).toBeGreaterThan(0);
        const datasourceId = completeResult.datasourceId;
        expect(completeResult.summary.id).toBe(datasourceId);
        expect(completeResult.summary.providerId).toBe("amazon-s3");
        expect(completeResult.summary.status).toBe("connected");

        // 3. credential-persisted + auth-completed pair.
        const persisted = await cli.waitForEvent("credential-persisted");
        const completed = await cli.waitForEvent("auth-completed");
        expect((persisted.payload as { datasourceId: string }).datasourceId)
          .toBe(datasourceId);
        expect((completed.payload as { datasourceId: string }).datasourceId)
          .toBe(datasourceId);

        // 4. credentials.json on disk has an entry for the new datasource.
        const credPath = path.join(scratchDir, "credentials.json");
        // The store may write asynchronously; poll briefly.
        let raw = "";
        for (let i = 0; i < 30; i += 1) {
          if (fs.existsSync(credPath)) {
            raw = await fsp.readFile(credPath, "utf-8");
            if (raw.includes(datasourceId)) break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(raw).not.toBe("");
        const parsed = JSON.parse(raw) as {
          schemaVersion: 1;
          credentials: Record<string, unknown>;
        };
        expect(parsed.schemaVersion).toBe(1);
        expect(parsed.credentials[datasourceId]).toBeDefined();
      } finally {
        cli.close();
      }
    },
    15_000,
  );
});
