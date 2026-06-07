// Integration tests for the add-download-overwrite-confirm conflict gate
// (tasks.md §7.1 / §7.2). Where commands/__tests__/files-download.test.ts
// drives the handler factory directly with hand-built fakes, this suite
// exercises the gate through `buildCommandHandlers` — the production handler
// registry — against a REAL on-disk tmpdir (the handler wires real node fs
// via createDefaultFilesDownloadDeps). Only the remote provider (engine)
// and the post-download hash are faked. This proves the gate is actually
// wired into the constructed handler map and that its fs.stat probe, the
// "keep-both" O_CREAT|O_EXCL suffix resolution, and the byte write all
// behave correctly against the real filesystem.

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DatasourceClient,
  DatasourceType,
  DownloadResult,
} from "@ft5/fs-datasource-engine";

import { buildCommandHandlers } from "../commands/handlers.js";
import type { CommandHandlers } from "../ipc/server.js";
import { applyMigrations } from "../db/migrations.js";
import { createEventBus, type EventBus } from "../events/event-bus.js";
import {
  createDownloadRegistry,
  type DownloadRegistry,
} from "../downloads/registry.js";
import type {
  EngineBusEvent,
  EngineBusSubscriber,
} from "../commands/files-download.js";

const ctx = {
  connection: { id: 1, closed: false, sendEvent: () => undefined },
} as const;

const SOURCE_PATH = "/welcome.pdf";
const DOWNLOAD_BYTES = Buffer.alloc(2048, 0xcd);

function makeEngineBus(): EngineBusSubscriber {
  const subscribers = new Set<(e: EngineBusEvent) => void>();
  return {
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
  };
}

function makeFakeClient(
  overrides: Partial<DatasourceClient<DatasourceType>> = {},
): DatasourceClient<DatasourceType> {
  return {
    type: "google-drive",
    datasourceId: "ds-1",
    status: vi.fn(),
    testConnection: vi.fn(),
    authenticate: vi.fn(),
    listDirectory: vi.fn(),
    search: vi.fn(),
    getMetadata: vi.fn().mockResolvedValue({
      handle: "h-1",
      kind: "file",
      name: "welcome.pdf",
      path: SOURCE_PATH,
      size: DOWNLOAD_BYTES.length,
      mimeFamily: "document",
      modifiedAt: Date.parse("2026-04-28T00:00:00.000Z"),
      // The handler's integrity check compares the written file's hash
      // (here forced to "deadbeef" via the injected hashComputer) against
      // this provider checksum, so they must match for keep-both to succeed.
      providerMetadata: { md5Checksum: "deadbeef" },
    }),
    deleteFile: vi.fn(),
    deleteDirectory: vi.fn(),
    rename: vi.fn(),
    downloadFile: vi.fn(),
    uploadFile: vi.fn(),
    getQuota: vi.fn(),
    ...overrides,
  } as unknown as DatasourceClient<DatasourceType>;
}

let cleanup: string[] = [];
let db: Database.Database;
let bus: EventBus;
let tmpDir: string;
let registry: DownloadRegistry;
let downloadFileSpy: ReturnType<typeof vi.fn>;
let handlers: CommandHandlers;

beforeEach(async () => {
  const dbFile = path.join(
    os.tmpdir(),
    `ft5-dlconflict-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  cleanup.push(dbFile);
  db = new Database(dbFile);
  applyMigrations(db);
  bus = createEventBus();
  registry = createDownloadRegistry();
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ft5-dlconflict-"));
  cleanup.push(tmpDir);

  downloadFileSpy = vi.fn(
    async (): Promise<DownloadResult> => ({
      stream: Readable.from([DOWNLOAD_BYTES]),
      contentLength: DOWNLOAD_BYTES.length,
    }),
  );
  const client = makeFakeClient({ downloadFile: downloadFileSpy });

  handlers = buildCommandHandlers({
    db,
    bus,
    serviceVersion: "0.0.0-test",
    serviceUuid: "test-uuid",
    resolveClient: async () => client,
    downloadRegistry: registry,
    engineBus: makeEngineBus(),
    // Force the post-download integrity hash to match the provider md5
    // ("deadbeef") regardless of the on-disk path, so the keep-both cycle
    // completes deterministically without coupling to the suffixed path.
    hashComputer: { hashFile: async () => "deadbeef" },
  });
});

afterEach(async () => {
  try {
    db.close();
  } catch {
    /* tolerated */
  }
  for (const f of cleanup) {
    await fsp.rm(f, { recursive: true, force: true }).catch(() => undefined);
  }
  cleanup = [];
  vi.restoreAllMocks();
});

describe("files:download conflict gate — integration through buildCommandHandlers", () => {
  it("§7.1 conflictPolicy 'fail' + existing destination → conflict envelope returned BEFORE engine.downloadFile, registry untouched, original file intact", async () => {
    const toPath = path.join(tmpDir, "welcome.pdf");
    await fsp.writeFile(toPath, "ORIGINAL CONTENT");

    const handler = handlers["files:download"];
    expect(handler, "files:download must be wired into the handler map").toBeTypeOf(
      "function",
    );

    const res = await handler!(
      { datasourceId: "ds-1", path: SOURCE_PATH, toPath, conflictPolicy: "fail" },
      ctx,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.tag).toBe("conflict");
      expect(res.error.existingPath).toBe(toPath);
      expect(res.error.existingSize).toBe("ORIGINAL CONTENT".length);
      expect(typeof res.error.existingModifiedAt).toBe("string");
      // ISO 8601 round-trips to a valid instant.
      expect(Number.isNaN(Date.parse(res.error.existingModifiedAt!))).toBe(false);
    }

    // Ordering: the gate short-circuits before any provider byte transfer.
    expect(downloadFileSpy).not.toHaveBeenCalled();
    // No job was minted / no registry entry created.
    expect(registry.findByKey("ds-1", SOURCE_PATH)).toBeUndefined();
    // The pre-existing file is byte-for-byte untouched.
    expect(await fsp.readFile(toPath, "utf8")).toBe("ORIGINAL CONTENT");
  });

  it("§7.2 conflictPolicy 'keep-both' + existing destination → writes the suffixed path, returns the suffixed savedPath, leaves the original (partial) file untouched", async () => {
    const toPath = path.join(tmpDir, "welcome.pdf");
    const ORIGINAL = "EARLIER FAILED-RUN PARTIAL";
    await fsp.writeFile(toPath, ORIGINAL);

    const res = await handlers["files:download"]!(
      {
        datasourceId: "ds-1",
        path: SOURCE_PATH,
        toPath,
        conflictPolicy: "keep-both",
      },
      ctx,
    );

    const suffixed = path.join(tmpDir, "welcome (1).pdf");

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.savedPath).toBe(suffixed);
      expect(res.result.bytes).toBe(DOWNLOAD_BYTES.length);
    }
    expect(downloadFileSpy).toHaveBeenCalledTimes(1);

    // The download landed at the suffixed path with the fetched bytes.
    const written = await fsp.readFile(suffixed);
    expect(written.length).toBe(DOWNLOAD_BYTES.length);
    expect(written.equals(DOWNLOAD_BYTES)).toBe(true);

    // The pre-existing partial at the original toPath is NOT clobbered.
    expect(await fsp.readFile(toPath, "utf8")).toBe(ORIGINAL);
  });
});
