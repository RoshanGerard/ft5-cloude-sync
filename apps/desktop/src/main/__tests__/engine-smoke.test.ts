// Phase 11.1 — Engine smoke integration test.
//
// End-to-end round-trip across every Phase 1–10 layer in a single test:
//
//   handleDatasourcesUpload (live path)
//     → DatasourceRegistry (persistent, in-memory SQLite)
//     → SqliteCredentialStore (XOR-stubbed `safeStorage`)
//     → ClientFactory.create → real `S3Client`
//     → @aws-sdk/client-s3 (intercepted by aws-sdk-client-mock)
//     → EventBus (engine singleton's real bus)
//     → createEventBridge (subscribes, sanitizes, forwards to windows)
//     → mock BrowserWindow's webContents.send
//
// Only the AWS SDK command-dispatch layer is mocked. Every other seam —
// factory, engine singleton, registry, credential encryption, bus, event
// bridge, handler path — runs the real production code.
//
// Feature-flagged via `DATASOURCE_ENGINE_LIVE=1` so the handler takes the
// live branch instead of the legacy fixture branch.
//
// File location note: this test lives at `apps/desktop/src/main/__tests__/`
// instead of the `apps/desktop/src/main/ipc/__tests__/` path the 11.1 spec
// originally prescribed. The Phase 9.12 guardrail
// (`no-provider-sdk-imports.test.ts`) walks `ipc/` and fails on any direct
// `@aws-sdk/client-s3` import in that subtree. This smoke test legitimately
// needs to prime the AWS SDK mock at the command-dispatch layer, so it
// lives one level up (outside the guardrail's scope) and takes a
// `devDependency` on `@aws-sdk/client-s3` + `aws-sdk-client-mock`. The
// guardrail remains meaningful — production handler code under `ipc/` still
// cannot reach for provider SDKs — and the test exercises exactly the
// end-to-end plumbing 11.1 calls out.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client as AwsS3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";

import {
  DATASOURCES_CHANNELS,
  type DatasourceSummary,
  type StoredCredentials,
} from "@ft5/ipc-contracts";

// See `upload.test.ts` for why the electron mock factory goes through
// `vi.hoisted` — `vi.mock` is lifted above all imports, so the factory
// body must be self-contained. The XOR safeStorage stub is identical
// across the handler-test suite.
const { electronMockFactory } = vi.hoisted(() => {
  function xor(bytes: Buffer): Buffer {
    const out = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) {
      out[i] = (bytes[i] ?? 0) ^ 0x42;
    }
    return out;
  }
  return {
    electronMockFactory: () => ({
      safeStorage: {
        isEncryptionAvailable: (): boolean => true,
        encryptString: (p: string): Buffer => xor(Buffer.from(p, "utf8")),
        decryptString: (b: Buffer): string => xor(b).toString("utf8"),
      },
    }),
  };
});

vi.mock("electron", electronMockFactory);

import { openDatabase, runMigrations } from "../db/database.js";
import { DEFAULT_MIGRATIONS } from "../db/migrations.js";
import {
  getEngine,
  initEngine,
  resetEngineForTests,
} from "../datasources/engine.js";
import { createEventBridge } from "../ipc/datasources/event-bridge.js";
import {
  handleDatasourcesUpload,
  type UploadDeps,
} from "../ipc/datasources/upload.js";

type SqliteDatabase = ReturnType<typeof openDatabase>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DATASOURCE_ID = "ds-s3-smoke";

function makeS3Creds(): StoredCredentials {
  const now = 1_700_000_000_000;
  return {
    providerId: "amazon-s3",
    authResult: {
      // S3 strategy reads credentials from `authResult.meta`, not from
      // `accessToken` — see `readCredsFromStored` in s3-client.ts.
      accessToken: "",
      meta: {
        accessKeyId: "AKIAFAKE-SMOKE",
        secretAccessKey: "SK/fake-smoke",
        region: "us-east-1",
        bucket: "smoke-bucket",
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

function makeSummary(): DatasourceSummary {
  return {
    id: DATASOURCE_ID,
    displayName: "Smoke Bucket",
    providerId: "amazon-s3",
    status: "connected",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 0,
  };
}

// Minimal BrowserWindow stub — mirrors `event-bridge.test.ts`.
interface FakeWindow {
  isDestroyed: ReturnType<typeof vi.fn>;
  webContents: {
    send: ReturnType<typeof vi.fn>;
  };
}

function makeWindow(): FakeWindow {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: {
      send: vi.fn(),
    },
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("engine smoke — upload round-trip", () => {
  const s3Mock = mockClient(AwsS3Client);
  let db: SqliteDatabase;
  let tmpDir: string;
  let tmpFile: string;
  let prevEngineLive: string | undefined;

  beforeAll(() => {
    // Feature-flag the handler into its live branch for the whole file.
    prevEngineLive = process.env.DATASOURCE_ENGINE_LIVE;
    process.env.DATASOURCE_ENGINE_LIVE = "1";
  });

  afterAll(() => {
    if (prevEngineLive === undefined) {
      delete process.env.DATASOURCE_ENGINE_LIVE;
    } else {
      process.env.DATASOURCE_ENGINE_LIVE = prevEngineLive;
    }
  });

  beforeEach(async () => {
    resetEngineForTests();
    s3Mock.reset();

    db = openDatabase(":memory:");
    runMigrations(db, DEFAULT_MIGRATIONS);
    initEngine(db);

    // Seed a real S3 datasource row + encrypted credential blob through the
    // registry — no shortcuts around the production add() path.
    await getEngine().registry.add(makeSummary(), makeS3Creds());

    // Write a small real file for the S3 strategy to stream. `createReadStream`
    // + `statSync` inside `doUploadFileImpl` need a real path on disk.
    tmpDir = mkdtempSync(join(tmpdir(), "engine-smoke-"));
    tmpFile = join(tmpDir, "hello.txt");
    writeFileSync(tmpFile, "engine-smoke-payload");
  });

  afterEach(() => {
    resetEngineForTests();
    s3Mock.reset();
    db.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* intentional — test cleanup best-effort */
    }
  });

  it("upload round-trip — handler → engine → S3 mock → bus → IPC forward → renderer cb", async () => {
    // 1. Prime the AWS SDK mock. lib-storage's `Upload` may route through
    //    either simple PutObject (small body) or multipart (large body),
    //    so prime both paths defensively — matches s3-client.contract.test.ts.
    //    HeadBucket is primed because a background health check could
    //    otherwise reject and surface as a stray auth-revoked event.
    s3Mock.on(HeadBucketCommand).resolves({});
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"smoke-etag"' });
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: "smoke-uid" });
    s3Mock.on(UploadPartCommand).resolves({ ETag: '"smoke-part-1"' });
    s3Mock
      .on(CompleteMultipartUploadCommand)
      .resolves({ ETag: '"smoke-etag"' });

    // 2. Create the event bridge over the engine's real bus; register a
    //    mock window. Collect every event that crosses the IPC boundary in
    //    delivery order.
    const bridge = createEventBridge(getEngine().bus);
    const mockWin = makeWindow();
    bridge.registerWindow(mockWin as unknown as Electron.BrowserWindow);

    interface DeliveredEvent {
      event: string;
      datasourceType: string;
      datasourceId: string;
      ts: number;
      payload: Record<string, unknown>;
    }
    const received: DeliveredEvent[] = [];
    mockWin.webContents.send.mockImplementation(
      (channel: string, payload: unknown) => {
        if (channel === DATASOURCES_CHANNELS.event) {
          received.push(payload as DeliveredEvent);
        }
      },
    );

    // 3. Build handler deps. `showOpenDialog` returns EXACTLY ONE file so
    //    the handler invokes `uploadFile` exactly once — one transaction,
    //    one terminal `file-created`.
    const deps: UploadDeps = {
      showOpenDialog: vi.fn().mockResolvedValue({
        canceled: false,
        filePaths: [tmpFile],
      }),
      sendProgress: vi.fn(),
      nextTransactionId: vi.fn().mockReturnValue("smoke-tx-1"),
    };

    // 4. Drive the upload handler through its live branch.
    const response = await handleDatasourcesUpload(
      { datasourceId: DATASOURCE_ID },
      deps,
    );
    expect(response.transactionId).toBe("smoke-tx-1");

    // 5. Event assertions.
    //
    //    The bus coalescer throttles streaming `uploading` ticks to one per
    //    second / per 10% progress delta — with a mocked SDK resolving
    //    synchronously, the pre-op `uploading` is usually the only one that
    //    gets through before the terminal. Assert only "at least one" so
    //    we do not race the coalescer's window.
    const uploadingEvents = received.filter((e) => e.event === "uploading");
    const fileCreatedEvents = received.filter(
      (e) => e.event === "file-created",
    );
    const uploadFailedEvents = received.filter(
      (e) => e.event === "upload-failed",
    );

    expect(uploadingEvents.length).toBeGreaterThanOrEqual(1);
    expect(fileCreatedEvents).toHaveLength(1);
    expect(uploadFailedEvents).toHaveLength(0);

    // Ordering: the single `file-created` must come after every `uploading`.
    // `received` is captured in delivery order, so array indices are the
    // authoritative order check — no `ts` comparison needed.
    const lastUploadingIdx = received
      .map((e) => e.event)
      .lastIndexOf("uploading");
    const fileCreatedIdx = received
      .map((e) => e.event)
      .indexOf("file-created");
    expect(fileCreatedIdx).toBeGreaterThan(lastUploadingIdx);

    // Every event envelope carries the correct datasourceType + id.
    for (const ev of received) {
      expect(ev.datasourceType).toBe("amazon-s3");
      expect(ev.datasourceId).toBe(DATASOURCE_ID);
    }

    // 6. Cleanup.
    bridge.dispose();
  });
});
