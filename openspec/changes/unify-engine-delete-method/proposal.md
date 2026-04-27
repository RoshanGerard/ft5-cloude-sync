# Proposal: Unify engine delete into a single `delete` method

**Status**: Stub. Spawned by interface-consistency observation during
`add-engine-rename-download` brainstorming on 2026-04-27.

## Why

`add-engine-rename-download` consolidated the engine's rename surface
into a single `rename(target, newName, conflictPolicy)` method whose
strategy implementations resolve file-vs-directory within their own
provider context. The decision rests on the strategy pattern's
encapsulation principle: the strategy is the right place to dispatch
on provider-specific quirks (S3 needs introspection; Drive/OneDrive
have a uniform API).

The existing engine surface still has the older split: `deleteFile` +
`deleteDirectory`. The split predates the consolidation principle and
exists for a different reason — `deleteDirectory` is hardcoded to
throw `Unsupported` for product stability (Decision 10 of the original
`add-fs-datasource-engine` design). Recursive directory delete was
deemed too dangerous for v1 across the board, regardless of which
provider one targets.

The split now reads as inconsistent against the rename design. New
contributors will reasonably ask "why does rename use one method but
delete use two?" and the answer ("historical reason, plus a global
product policy that happened to be encoded in the interface shape")
is harder to defend than collapsing both to one method whose strategy
makes the decision.

This change collapses delete to one method AND surfaces the underlying
product question that Decision 10 was answering: should directory
delete remain unsupported v1-wide, or are we ready to enable it
per-provider with appropriate UX guardrails?

## Out of scope

- Adding new directory-delete UX (recursive confirmation flow, tree
  count preview, undo window). If we decide to enable directory
  delete, that UX work is a separate scope question.
- Changing the bulk-delete IPC shape (`files:remove` already accepts
  multiple targets). The wire-level change here is renaming a couple
  of internal handler dispatches, not redesigning bulk-delete.

## Open questions (resolve during `/opsx:propose`)

1. **Directory delete: enable or keep unsupported?** Three branches:
   (α) Keep "directory delete unsupported globally" — collapse the
       interface but the strategy throws Unsupported for kind=directory.
       Pure cosmetic refactor. Easiest, lowest blast radius.
   (β) Enable directory delete per-provider. Drive supports it
       directly (`files.delete({fileId})`), OneDrive supports it
       (`DELETE /items/{id}`), S3 requires iterate-and-delete-keys.
       Real product change with UX implications.
   (γ) Enable empty-directory delete only (refuse if non-empty).
       Smaller surface than β; still requires a sibling-count check
       in each strategy.
   Recommend resolving via `/opsx:explore` brainstorm before this
   proposal is promoted, since the answer changes the implementation
   scope substantially.
2. **`conflictPolicy` parameter for delete?** Rename has it; delete
   could match for parallelism (e.g., `policy: "fail-if-non-empty"
   | "force-recursive"`). Or keep delete simpler — delete has no
   conflict semantics, just "yes / no". Recommend: no policy
   parameter for v1; if directory delete enables, recursion is
   the implicit "force" mode and it's a separate flag.
3. **Migration of existing `files:remove` consumers.** The IPC
   command stays; only the underlying engine handler dispatch
   changes. Consumers see no contract difference unless we change
   the response shape (we shouldn't).
4. **Mock-fs's `remove` function** already dispatches on
   `target.kind` — no change needed there.
5. **Test surface migration.** The base class's `deleteDirectory`
   "always Unsupported" scenario test (Decision 10) gets replaced
   by the strategy-level scenarios (per branch α/β/γ chosen).

## Acceptance criteria (once promoted)

- `DatasourceClient<T>` exposes `delete(target, …)` and removes
  `deleteFile` + `deleteDirectory`.
- Strategies determine kind within their own context, parallel to
  `rename`'s introspection pattern (S3 `HeadObject`/`ListObjectsV2`,
  Drive metadata, OneDrive `folder` facet).
- Behavior on directory delete matches the chosen branch (α/β/γ from
  Q1 above). Tests cover the chosen behavior end-to-end.
- `files:remove` IPC command unchanged at the wire level. Internal
  handler dispatch updates to call the new method.
- `mock-fs.ts` `remove` function continues to work (already
  kind-dispatching).

## Provenance

- Spawned by `add-engine-rename-download` brainstorming on 2026-04-27,
  specifically the user observation: "looks like i missed the delete
  implementation too then we need to use one delete method just like
  we decided for the rename."
- Decision 10 of `add-fs-datasource-engine` (the original "delete
  directory unsupported for product stability" decision) is the
  product-policy gate this change has to revisit.
- Consistency with `rename` (one method per concern, strategy
  introspects) is the design-pattern goal.
