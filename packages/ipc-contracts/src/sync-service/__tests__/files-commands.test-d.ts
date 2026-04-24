// Type-level assertions for the `files:*` sync-service commands added by the
// `wire-file-explorer-to-service` change (design.md Decision 1 / Decision 2).
//
// These commands carry the renderer's file-explorer primitives over the
// `fs-sync-service` RPC. The response shape is a tagged discriminated union
// (`{ ok: true; value } | { ok: false; error }`) so the main-process IPC
// handler can forward the outcome to the renderer without re-wrapping, and so
// renderer callers can branch on `.error.tag` for auth / network / rate-limit
// recovery UX.

import { describe, expectTypeOf, it } from "vitest";

import type { FileEntry } from "../../files.js";
import type {
  COMMAND_NAMES,
  CommandError,
  CommandMap,
  CommandName,
  CommandParams,
  CommandResult,
} from "../commands.js";

// ---- Shared envelope ------------------------------------------------------

type FilesErrorTag =
  | "auth-revoked"
  | "disconnected"
  | "rate-limited"
  | "other";

interface FilesErrorShape {
  readonly tag: FilesErrorTag;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

type FilesEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: FilesErrorShape };

// Per-path remove outcome — design.md Decision 2: per-path success/failure
// so the renderer can render "3 removed, 1 failed" without a second probe.
type FilesRemoveEntryResult =
  | { readonly path: string; readonly ok: true }
  | {
      readonly path: string;
      readonly ok: false;
      readonly error: {
        readonly tag: FilesErrorTag;
        readonly message: string;
      };
    };

// ---- Tests ----------------------------------------------------------------

describe("sync-service files:* command contract", () => {
  it("CommandMap registers all four files:* commands", () => {
    expectTypeOf<CommandMap["files:list"]>().not.toBeNever();
    expectTypeOf<CommandMap["files:stat"]>().not.toBeNever();
    expectTypeOf<CommandMap["files:search"]>().not.toBeNever();
    expectTypeOf<CommandMap["files:remove"]>().not.toBeNever();
  });

  it("CommandName includes every files:* command", () => {
    type ExpectedFiles =
      | "files:list"
      | "files:stat"
      | "files:search"
      | "files:remove";
    expectTypeOf<ExpectedFiles>().toMatchTypeOf<CommandName>();
  });

  it("COMMAND_NAMES tuple contains every files:* command", () => {
    type Names = (typeof COMMAND_NAMES)[number];
    expectTypeOf<"files:list">().toMatchTypeOf<Names>();
    expectTypeOf<"files:stat">().toMatchTypeOf<Names>();
    expectTypeOf<"files:search">().toMatchTypeOf<Names>();
    expectTypeOf<"files:remove">().toMatchTypeOf<Names>();
  });

  // -- files:list -----------------------------------------------------------

  it("files:list params are { datasourceId, path }", () => {
    expectTypeOf<CommandParams<"files:list">>().toEqualTypeOf<{
      readonly datasourceId: string;
      readonly path: string;
    }>();
  });

  it("files:list result is { entries: FileEntry[]; truncated: boolean }", () => {
    expectTypeOf<CommandResult<"files:list">>().toEqualTypeOf<{
      readonly entries: readonly FileEntry[];
      readonly truncated: boolean;
    }>();
  });

  it("files:list error carries the tagged envelope error shape", () => {
    expectTypeOf<CommandError<"files:list">>().toEqualTypeOf<FilesErrorShape>();
  });

  // -- files:stat -----------------------------------------------------------

  it("files:stat params are { datasourceId, path }", () => {
    expectTypeOf<CommandParams<"files:stat">>().toEqualTypeOf<{
      readonly datasourceId: string;
      readonly path: string;
    }>();
  });

  it("files:stat result is { entry: FileEntry }", () => {
    expectTypeOf<CommandResult<"files:stat">>().toEqualTypeOf<{
      readonly entry: FileEntry;
    }>();
  });

  it("files:stat error carries the tagged envelope error shape", () => {
    expectTypeOf<CommandError<"files:stat">>().toEqualTypeOf<FilesErrorShape>();
  });

  // -- files:search ---------------------------------------------------------

  it("files:search params are { datasourceId, query, path }", () => {
    expectTypeOf<CommandParams<"files:search">>().toEqualTypeOf<{
      readonly datasourceId: string;
      readonly query: string;
      readonly path: string;
    }>();
  });

  it("files:search result is { entries, truncated }", () => {
    expectTypeOf<CommandResult<"files:search">>().toEqualTypeOf<{
      readonly entries: readonly FileEntry[];
      readonly truncated: boolean;
    }>();
  });

  it("files:search error carries the tagged envelope error shape", () => {
    expectTypeOf<
      CommandError<"files:search">
    >().toEqualTypeOf<FilesErrorShape>();
  });

  // -- files:remove ---------------------------------------------------------

  it("files:remove params are { datasourceId, paths: string[] }", () => {
    expectTypeOf<CommandParams<"files:remove">>().toEqualTypeOf<{
      readonly datasourceId: string;
      readonly paths: readonly string[];
    }>();
  });

  it("files:remove result is { results: per-path outcomes }", () => {
    expectTypeOf<CommandResult<"files:remove">>().toEqualTypeOf<{
      readonly results: readonly FilesRemoveEntryResult[];
    }>();
  });

  it("files:remove command-level error carries the tagged envelope shape", () => {
    // The command-level error fires when the request itself is rejected
    // (e.g. bad datasourceId, auth revoked before any path was attempted).
    // Per-path failures travel inside `result.results`, not `error`.
    expectTypeOf<
      CommandError<"files:remove">
    >().toEqualTypeOf<FilesErrorShape>();
  });

  // -- Envelope shape --------------------------------------------------------

  it("FilesEnvelope is the shape used by the outer RPC response for files:*", () => {
    // Sanity: discriminating on `ok` picks out `value` vs `error`.
    type ListEnvelope = FilesEnvelope<CommandResult<"files:list">>;
    expectTypeOf<Extract<ListEnvelope, { ok: true }>["value"]>().toEqualTypeOf<
      CommandResult<"files:list">
    >();
    expectTypeOf<
      Extract<ListEnvelope, { ok: false }>["error"]
    >().toEqualTypeOf<FilesErrorShape>();
  });
});
