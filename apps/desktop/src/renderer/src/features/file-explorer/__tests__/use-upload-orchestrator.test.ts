import { FilesErrorTag } from "@ft5/ipc-contracts";
import { describe, expect, it, vi } from "vitest";

import type {
  FilesStatRequest,
  FilesStatResponse,
  FilesUploadRequest,
  FilesUploadResponse,
} from "@ft5/ipc-contracts";

import type {
  ConflictResolver,
  UploadFileItem,
  UploadToaster,
} from "../use-upload-orchestrator.js";
import { createUploadOrchestrator } from "../use-upload-orchestrator.js";

// Orchestrator unit tests. The hook is stateless — it returns an
// imperative `start()` — so we call it as a plain function here.
// Every IPC dependency is injected via the `api` prop so these tests
// never touch `window.api`.

type StatFn = (req: FilesStatRequest) => Promise<FilesStatResponse>;
type UploadFn = (req: FilesUploadRequest) => Promise<FilesUploadResponse>;

function makeFile(basename: string): UploadFileItem {
  return {
    sourcePath: `C:/local/${basename}`,
    basename,
    sizeBytes: 1024,
  };
}

function makeToaster(): UploadToaster & {
  onJobDispatched: ReturnType<typeof vi.fn>;
  onBatchError: ReturnType<typeof vi.fn>;
} {
  return {
    onJobDispatched: vi.fn(),
    onBatchError: vi.fn(),
  };
}

function makeResolver(
  impl?: ConflictResolver["resolve"],
): ConflictResolver & { resolve: ReturnType<typeof vi.fn> } {
  return {
    resolve: vi.fn(
      impl ??
        (async () => ({
          aborted: false as const,
          choices: [],
        })),
    ),
  };
}

function statNotFound(): FilesStatResponse {
  // The renderer-facing envelope collapses engine-level `not-found` into
  // `tag: "other"` (see apps/desktop/src/main/ipc/files/error-envelope.ts).
  // So "target absent" presents as `ok: false` with tag `"other"`.
  return {
    ok: false,
    error: {
      tag: FilesErrorTag.Other,
      message: "not found",
      retryable: false,
    },
  };
}

function statExists(path: string): FilesStatResponse {
  return {
    ok: true,
    value: {
      entry: {
        id: `existing-${path}`,
        kind: "file",
        name: path.split("/").pop() ?? path,
        path,
        parentPath: path.split("/").slice(0, -1).join("/") || "/",
        size: 2048,
        mimeFamily: "document",
        mimeType: "application/pdf",
        modifiedAt: "2026-03-01T00:00:00.000Z",
        createdAt: null,
        providerMetadata: {},
      },
    },
  };
}

describe("createUploadOrchestrator", () => {
  it("dispatches one upload per file in parallel when no conflicts exist", async () => {
    const files = [makeFile("a.txt"), makeFile("b.txt"), makeFile("c.txt")];
    const stat: StatFn = vi.fn(async () => statNotFound());
    let seq = 0;
    const upload: UploadFn = vi.fn(async () => {
      seq += 1;
      return { ok: true, value: { jobId: `job-${seq}` } };
    });
    const toaster = makeToaster();
    const resolver = makeResolver();

    const orchestrator = createUploadOrchestrator({
      datasourceId: "ds-1",
      targetDir: "/projects/2026",
      files,
      conflictResolver: resolver,
      toaster,
      api: { stat, upload },
    });
    await orchestrator.start();

    expect(stat).toHaveBeenCalledTimes(3);
    expect(upload).toHaveBeenCalledTimes(3);
    expect(resolver.resolve).not.toHaveBeenCalled();

    const uploadCalls = (upload as unknown as ReturnType<typeof vi.fn>).mock
      .calls as [FilesUploadRequest][];
    const uploadedBasenames = uploadCalls
      .map(([req]) => req.targetPath.split("/").pop() ?? "")
      .sort();
    expect(uploadedBasenames).toEqual(["a.txt", "b.txt", "c.txt"]);

    // All dispatches use "overwrite" policy for non-conflict files per
    // design.md Decision 8.
    for (const [req] of uploadCalls) {
      expect(req.conflictPolicy).toBe("overwrite");
      expect(req.datasourceId).toBe("ds-1");
    }

    // One successful dispatch → one toast notification.
    expect(toaster.onJobDispatched).toHaveBeenCalledTimes(3);
    const dispatchedJobIds = toaster.onJobDispatched.mock.calls
      .map(([arg]) => (arg as { jobId: string }).jobId)
      .sort();
    expect(dispatchedJobIds).toEqual(["job-1", "job-2", "job-3"]);
    expect(toaster.onBatchError).not.toHaveBeenCalled();
  });

  it("normalizes trailing slashes when joining targetDir and basename", async () => {
    const files = [makeFile("a.txt")];
    const stat: StatFn = vi.fn(async () => statNotFound());
    const upload: UploadFn = vi.fn(async () => ({
      ok: true,
      value: { jobId: "job-1" },
    }));

    const orchestrator = createUploadOrchestrator({
      datasourceId: "ds-1",
      targetDir: "/projects/2026/",
      files,
      conflictResolver: makeResolver(),
      toaster: makeToaster(),
      api: { stat, upload },
    });
    await orchestrator.start();

    const call = (upload as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [FilesUploadRequest];
    expect(call[0].targetPath).toBe("/projects/2026/a.txt");
  });

  it("prompts the resolver for conflicts and dispatches the chosen policy", async () => {
    const files = [makeFile("a.txt"), makeFile("b.txt"), makeFile("c.txt")];
    // b.txt exists; a.txt and c.txt do not.
    const stat: StatFn = vi.fn(async (req) => {
      if (req.path.endsWith("/b.txt")) return statExists(req.path);
      return statNotFound();
    });
    const upload: UploadFn = vi.fn(async (req) => ({
      ok: true,
      value: { jobId: `job-${req.targetPath.split("/").pop()}` },
    }));
    const toaster = makeToaster();
    const resolver = makeResolver(async () => ({
      aborted: false,
      choices: [{ kind: "overwrite" }],
    }));

    const orchestrator = createUploadOrchestrator({
      datasourceId: "ds-1",
      targetDir: "/projects/2026",
      files,
      conflictResolver: resolver,
      toaster,
      api: { stat, upload },
    });
    await orchestrator.start();

    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    // Resolver should have received exactly one conflict, for b.txt.
    const resolverArg = resolver.resolve.mock.calls[0]?.[0] as Array<{
      file: UploadFileItem;
    }>;
    expect(resolverArg).toHaveLength(1);
    expect(resolverArg[0]?.file.basename).toBe("b.txt");

    expect(upload).toHaveBeenCalledTimes(3);
    const byBasename = new Map<string, FilesUploadRequest>();
    for (const [req] of (upload as unknown as ReturnType<typeof vi.fn>).mock
      .calls as [FilesUploadRequest][]) {
      byBasename.set(req.targetPath.split("/").pop() ?? "", req);
    }
    expect(byBasename.get("a.txt")?.conflictPolicy).toBe("overwrite");
    expect(byBasename.get("b.txt")?.conflictPolicy).toBe("overwrite");
    expect(byBasename.get("c.txt")?.conflictPolicy).toBe("overwrite");
    expect(toaster.onJobDispatched).toHaveBeenCalledTimes(3);
    expect(toaster.onBatchError).not.toHaveBeenCalled();
  });

  it("skips dispatch for conflicts resolved to 'skip' but still dispatches the others", async () => {
    const files = [makeFile("a.txt"), makeFile("b.txt")];
    const stat: StatFn = vi.fn(async (req) => {
      if (req.path.endsWith("/a.txt")) return statExists(req.path);
      return statNotFound();
    });
    const upload: UploadFn = vi.fn(async () => ({
      ok: true,
      value: { jobId: "job-x" },
    }));
    const toaster = makeToaster();
    const resolver = makeResolver(async () => ({
      aborted: false,
      choices: [{ kind: "skip" }],
    }));

    const orchestrator = createUploadOrchestrator({
      datasourceId: "ds-1",
      targetDir: "/projects/2026",
      files,
      conflictResolver: resolver,
      toaster,
      api: { stat, upload },
    });
    await orchestrator.start();

    expect(upload).toHaveBeenCalledTimes(1);
    const call = (upload as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [FilesUploadRequest];
    expect(call[0].targetPath).toBe("/projects/2026/b.txt");
    expect(toaster.onJobDispatched).toHaveBeenCalledTimes(1);
  });

  it("maps 'duplicate' choice to conflictPolicy: 'duplicate'", async () => {
    const files = [makeFile("a.txt")];
    const stat: StatFn = vi.fn(async (req) => statExists(req.path));
    const upload: UploadFn = vi.fn(async () => ({
      ok: true,
      value: { jobId: "job-1" },
    }));
    const resolver = makeResolver(async () => ({
      aborted: false,
      choices: [{ kind: "duplicate" }],
    }));

    const orchestrator = createUploadOrchestrator({
      datasourceId: "ds-1",
      targetDir: "/projects/2026",
      files,
      conflictResolver: resolver,
      toaster: makeToaster(),
      api: { stat, upload },
    });
    await orchestrator.start();

    const call = (upload as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [FilesUploadRequest];
    expect(call[0].conflictPolicy).toBe("duplicate");
  });

  it("aborts the entire batch and surfaces a red toast when preflight stat returns auth-revoked", async () => {
    const files = [makeFile("a.txt"), makeFile("b.txt")];
    const stat: StatFn = vi.fn(async (req) => {
      if (req.path.endsWith("/a.txt")) {
        return {
          ok: false,
          error: {
            tag: FilesErrorTag.AuthRevoked,
            message: "Token expired",
            retryable: false,
          },
        };
      }
      return statNotFound();
    });
    const upload: UploadFn = vi.fn();
    const toaster = makeToaster();

    const orchestrator = createUploadOrchestrator({
      datasourceId: "ds-1",
      targetDir: "/projects/2026",
      files,
      conflictResolver: makeResolver(),
      toaster,
      api: { stat, upload },
    });
    await orchestrator.start();

    expect(upload).not.toHaveBeenCalled();
    expect(toaster.onJobDispatched).not.toHaveBeenCalled();
    expect(toaster.onBatchError).toHaveBeenCalledTimes(1);
    const message = toaster.onBatchError.mock.calls[0]?.[0] as string;
    expect(message).toMatch(/sign in again/i);
  });

  it("aborts the batch on 'disconnected' with a connection message", async () => {
    const files = [makeFile("a.txt")];
    const stat: StatFn = vi.fn(async () => ({
      ok: false,
      error: {
        tag: FilesErrorTag.Disconnected,
        message: "Network error",
        retryable: true,
      },
    }));
    const upload: UploadFn = vi.fn();
    const toaster = makeToaster();

    const orchestrator = createUploadOrchestrator({
      datasourceId: "ds-1",
      targetDir: "/projects/2026",
      files,
      conflictResolver: makeResolver(),
      toaster,
      api: { stat, upload },
    });
    await orchestrator.start();

    expect(upload).not.toHaveBeenCalled();
    expect(toaster.onBatchError).toHaveBeenCalledTimes(1);
    const message = toaster.onBatchError.mock.calls[0]?.[0] as string;
    expect(message).toMatch(/unreachable|connect/i);
  });

  it("aborts the batch on 'rate-limited' preflight", async () => {
    const files = [makeFile("a.txt")];
    const stat: StatFn = vi.fn(async () => ({
      ok: false,
      error: {
        tag: FilesErrorTag.RateLimited,
        message: "Slow down",
        retryable: true,
        retryAfterMs: 5000,
      },
    }));
    const upload: UploadFn = vi.fn();
    const toaster = makeToaster();

    const orchestrator = createUploadOrchestrator({
      datasourceId: "ds-1",
      targetDir: "/projects/2026",
      files,
      conflictResolver: makeResolver(),
      toaster,
      api: { stat, upload },
    });
    await orchestrator.start();

    expect(upload).not.toHaveBeenCalled();
    expect(toaster.onBatchError).toHaveBeenCalledTimes(1);
  });

  it("aborts the batch when the stat promise itself throws (IPC failure)", async () => {
    const files = [makeFile("a.txt")];
    const stat: StatFn = vi.fn(async () => {
      throw new Error("bridge is dead");
    });
    const upload: UploadFn = vi.fn();
    const toaster = makeToaster();

    const orchestrator = createUploadOrchestrator({
      datasourceId: "ds-1",
      targetDir: "/projects/2026",
      files,
      conflictResolver: makeResolver(),
      toaster,
      api: { stat, upload },
    });
    await orchestrator.start();

    expect(upload).not.toHaveBeenCalled();
    expect(toaster.onBatchError).toHaveBeenCalledTimes(1);
    const message = toaster.onBatchError.mock.calls[0]?.[0] as string;
    expect(message).toContain("bridge is dead");
  });

  it("cancels the batch without any dispatches when the resolver returns aborted", async () => {
    const files = [makeFile("a.txt"), makeFile("b.txt")];
    const stat: StatFn = vi.fn(async (req) => statExists(req.path));
    const upload: UploadFn = vi.fn();
    const toaster = makeToaster();
    const resolver = makeResolver(async () => ({ aborted: true }));

    const orchestrator = createUploadOrchestrator({
      datasourceId: "ds-1",
      targetDir: "/projects/2026",
      files,
      conflictResolver: resolver,
      toaster,
      api: { stat, upload },
    });
    await orchestrator.start();

    expect(upload).not.toHaveBeenCalled();
    expect(toaster.onJobDispatched).not.toHaveBeenCalled();
    expect(toaster.onBatchError).not.toHaveBeenCalled();
  });

  it("emits onBatchError for each per-file upload failure but still dispatches the successes", async () => {
    const files = [makeFile("a.txt"), makeFile("b.txt")];
    const stat: StatFn = vi.fn(async () => statNotFound());
    const upload: UploadFn = vi.fn(async (req) => {
      if (req.targetPath.endsWith("/a.txt")) {
        return {
          ok: false,
          error: {
            tag: FilesErrorTag.Other,
            message: "disk full",
            retryable: false,
          },
        };
      }
      return { ok: true, value: { jobId: "job-b" } };
    });
    const toaster = makeToaster();

    const orchestrator = createUploadOrchestrator({
      datasourceId: "ds-1",
      targetDir: "/projects/2026",
      files,
      conflictResolver: makeResolver(),
      toaster,
      api: { stat, upload },
    });
    await orchestrator.start();

    expect(upload).toHaveBeenCalledTimes(2);
    expect(toaster.onJobDispatched).toHaveBeenCalledTimes(1);
    expect(toaster.onBatchError).toHaveBeenCalledTimes(1);
    const message = toaster.onBatchError.mock.calls[0]?.[0] as string;
    expect(message).toContain("disk full");
  });

  it("surfaces a `tag: 'conflict'` upload rejection through onBatchError with the existing-upload-in-progress message; the in-flight toast is unaffected", async () => {
    // §14.3 — when the service-side concurrent-target guard rejects a
    // SECOND request with `tag: "conflict"`, the renderer surfaces an
    // error toast pointing at the existing upload. The first
    // (in-flight) upload's toast is unaffected — it's owned by the
    // toaster's per-uploadJobId tracker, not by this dispatch path.
    //
    // The orchestrator routes the conflict envelope through
    // `onBatchError(message)` rather than `onJobDispatched` (no jobId
    // was minted). The renderer's Sonner toaster surfaces it as a
    // standalone error toast — same path as the auth-revoked /
    // disconnected / rate-limited preflight aborts. The full
    // existingUploadJobId is included in `error.message` so the user
    // can correlate to the existing toast (a future iteration could
    // surface a cross-toast pointer; v1 is just the message).
    const files = [makeFile("a.txt")];
    const stat: StatFn = vi.fn(async () => statNotFound());
    const upload: UploadFn = vi.fn(async () => ({
      ok: false,
      error: {
        tag: FilesErrorTag.Conflict,
        message: "An upload to this path is already in progress",
        retryable: false,
        existingUploadJobId: "u-first",
        existingPath: "/projects/2026/a.txt",
      },
    }));
    const toaster = makeToaster();

    const orchestrator = createUploadOrchestrator({
      datasourceId: "ds-1",
      targetDir: "/projects/2026",
      files,
      conflictResolver: makeResolver(),
      toaster,
      api: { stat, upload },
    });
    await orchestrator.start();

    expect(upload).toHaveBeenCalledTimes(1);
    expect(toaster.onJobDispatched).not.toHaveBeenCalled();
    expect(toaster.onBatchError).toHaveBeenCalledTimes(1);
    const message = toaster.onBatchError.mock.calls[0]?.[0] as string;
    expect(message).toMatch(/already in progress|in progress/i);
  });

  it("retry closure on onJobDispatched re-invokes upload with the same args and spawns a new toast", async () => {
    const files = [makeFile("a.txt")];
    const stat: StatFn = vi.fn(async () => statNotFound());
    let callCount = 0;
    const upload: UploadFn = vi.fn(async () => {
      callCount += 1;
      return { ok: true, value: { jobId: `job-${callCount}` } };
    });
    const toaster = makeToaster();

    const orchestrator = createUploadOrchestrator({
      datasourceId: "ds-1",
      targetDir: "/projects/2026",
      files,
      conflictResolver: makeResolver(),
      toaster,
      api: { stat, upload },
    });
    await orchestrator.start();

    expect(upload).toHaveBeenCalledTimes(1);
    expect(toaster.onJobDispatched).toHaveBeenCalledTimes(1);
    const firstCall = toaster.onJobDispatched.mock.calls[0]?.[0] as {
      jobId: string;
      basename: string;
      retry: () => Promise<void>;
    };
    expect(firstCall.jobId).toBe("job-1");
    expect(firstCall.basename).toBe("a.txt");

    await firstCall.retry();

    expect(upload).toHaveBeenCalledTimes(2);
    const retriedCall = (upload as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1] as [FilesUploadRequest];
    expect(retriedCall[0].targetPath).toBe("/projects/2026/a.txt");
    expect(retriedCall[0].sourcePath).toBe("C:/local/a.txt");
    expect(retriedCall[0].conflictPolicy).toBe("overwrite");
    expect(toaster.onJobDispatched).toHaveBeenCalledTimes(2);
    const secondToast = toaster.onJobDispatched.mock.calls[1]?.[0] as {
      jobId: string;
    };
    expect(secondToast.jobId).toBe("job-2");
  });
});
