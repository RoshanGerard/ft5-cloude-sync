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
  FilesCommandErrorShape,
  FilesErrorTag,
  FilesRemoveEntryResult,
} from "../commands.js";

// ---- Shared envelope ------------------------------------------------------
//
// `FilesCommandErrorShape` is exported from commands.ts and extends the
// transport-level `ErrorShape` (see frames.ts). The outer RPC envelope is
// already defined by `ResponseFrame` in frames.ts — the test below just
// asserts the shape the service returns inside its `error` leaf.

type FilesEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: FilesCommandErrorShape };

// ---- Tests ----------------------------------------------------------------

describe("sync-service files:* command contract", () => {
  it("CommandMap registers every files:* command", () => {
    expectTypeOf<CommandMap["files:list"]>().not.toBeNever();
    expectTypeOf<CommandMap["files:stat"]>().not.toBeNever();
    expectTypeOf<CommandMap["files:search"]>().not.toBeNever();
    expectTypeOf<CommandMap["files:remove"]>().not.toBeNever();
    expectTypeOf<CommandMap["files:rename"]>().not.toBeNever();
  });

  it("FilesErrorTag is the exact six-variant union", () => {
    expectTypeOf<FilesErrorTag>().toEqualTypeOf<
      | "auth-revoked"
      | "disconnected"
      | "rate-limited"
      | "other"
      | "invalid-datasource"
      | "conflict"
    >();
  });

  it("CommandName includes every files:* command", () => {
    type ExpectedFiles =
      | "files:list"
      | "files:stat"
      | "files:search"
      | "files:remove"
      | "files:rename";
    expectTypeOf<ExpectedFiles>().toMatchTypeOf<CommandName>();
  });

  it("COMMAND_NAMES tuple contains every files:* command", () => {
    type Names = (typeof COMMAND_NAMES)[number];
    expectTypeOf<"files:list">().toMatchTypeOf<Names>();
    expectTypeOf<"files:stat">().toMatchTypeOf<Names>();
    expectTypeOf<"files:search">().toMatchTypeOf<Names>();
    expectTypeOf<"files:remove">().toMatchTypeOf<Names>();
    expectTypeOf<"files:rename">().toMatchTypeOf<Names>();
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
    expectTypeOf<CommandError<"files:list">>().toEqualTypeOf<FilesCommandErrorShape>();
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
    expectTypeOf<CommandError<"files:stat">>().toEqualTypeOf<FilesCommandErrorShape>();
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
    >().toEqualTypeOf<FilesCommandErrorShape>();
  });

  // -- files:remove ---------------------------------------------------------

  it("files:remove params are { datasourceId, targets: readonly FilesRemoveTargetShape[] }", () => {
    expectTypeOf<CommandParams<"files:remove">>().toEqualTypeOf<{
      readonly datasourceId: string;
      readonly targets: readonly {
        readonly path: string;
        readonly handle: string;
        readonly kind: "directory" | "file";
      }[];
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
    >().toEqualTypeOf<FilesCommandErrorShape>();
  });

  // -- files:rename ---------------------------------------------------------

  it("files:rename params carry path / handle? / newName / conflictPolicy (no kind — Decision 1)", () => {
    expectTypeOf<CommandParams<"files:rename">>().toEqualTypeOf<{
      readonly datasourceId: string;
      readonly path: string;
      readonly handle?: string;
      readonly newName: string;
      readonly conflictPolicy: "fail" | "overwrite" | "keep-both";
    }>();
  });

  it("files:rename result is { entry: FileEntry }", () => {
    expectTypeOf<CommandResult<"files:rename">>().toEqualTypeOf<{
      readonly entry: FileEntry;
    }>();
  });

  it("files:rename error carries the tagged envelope error shape (existingPath populated when tag === 'conflict')", () => {
    expectTypeOf<
      CommandError<"files:rename">
    >().toEqualTypeOf<FilesCommandErrorShape>();
  });

  it("FilesCommandErrorShape.existingPath is a flat-optional string (Decision 7)", () => {
    // The field exists on every envelope but is only populated for
    // tag: "conflict" — flat-optional shape (NOT a discriminated union)
    // mirrors retryAfterMs.
    type Shape = FilesCommandErrorShape;
    expectTypeOf<Shape["existingPath"]>().toEqualTypeOf<string | undefined>();
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
    >().toEqualTypeOf<FilesCommandErrorShape>();
  });
});
