# Datasources UI — Design Reference

_Last updated: 2026-04-19 (review-round-3)_

This document is the human-readable companion to the `ui-ux-design` OpenSpec
change. It summarises what the datasources dashboard looks like, how its
states transition, the accessibility contract the underlying primitives honour,
and how a future contributor adds a new provider without touching the
dashboard, card, dialog shell, or store.

The **binding artifacts** are:

- **Decisions** in [`./design.md`](./design.md) (Decisions 1–18).
- **Requirements** in [`./specs/datasources-ui/spec.md`](./specs/datasources-ui/spec.md).
- **Types** in [`packages/ipc-contracts/src/datasources.ts`](../../../../packages/ipc-contracts/src/datasources.ts).

When this doc and any of the above disagree, the above wins and this doc is
stale — file a docs PR.

---

## 1. Dashboard wireframes

The dashboard is a single-pane view mounted at `/` (see Decision 4). It is
wrapped by the persistent app shell (header + footer, Decision 14) and the
`DatasourcesProvider` context (Decision 5). The dashboard itself resolves to
exactly one of four mutually-exclusive states:

```
DatasourcesState = loading | empty | populated | error
```

State is derived from the `list()` IPC call. Transition rules are in §3.

### 1.1 Loading

```
+----------------------------------------------------------------+
|  FT5 Unified Cloud Sync          [Settings]  [Theme ▾]         |  <- app header
+----------------------------------------------------------------+
|                                                                |
|   Datasources                                 [+ Add datasource]  <- dashboard toolbar
|                                                                |
|   +-----------------------+  +-----------------------+         |
|   | ░░░░░░░░░░░░░░░░░     |  | ░░░░░░░░░░░░░░░░░     |   ...   |  <- 3x skeleton cards
|   | ░░░░░░░░░░░           |  | ░░░░░░░░░░░           |         |     (shimmer animation)
|   | ░░░░░░░░░░░░░░░░░░░░░ |  | ░░░░░░░░░░░░░░░░░░░░░ |         |
|   +-----------------------+  +-----------------------+         |
|                                                                |
+----------------------------------------------------------------+
|                © 2026 Forti5 Tech. All rights reserved.        |  <- app footer
+----------------------------------------------------------------+
```

- Three skeleton cards render, each carrying `animate-skeleton-shimmer`
  (motion-budget Decision 10, gated by `motion-safe:`).
- The Add-datasource trigger is still interactable — loading does not block it.

### 1.2 Empty

```
+----------------------------------------------------------------+
|   Datasources                                 [+ Add datasource]|
|                                                                |
|                    ╭─────────╮                                 |
|                    │  ☁  ☁   │   <- EmptyDatasourcesIllustration|
|                    │ ▭ ▭ ▭   │      240x160, currentColor +    |
|                    ╰─────────╯      var(--primary) accent      |
|                                                                |
|              No cloud datasources connected yet                |
|          Connect Google Drive, OneDrive, or S3 to begin.       |
|                                                                |
|                   [+ Add datasource]                           |  <- primary CTA
|                                                                |
+----------------------------------------------------------------+
```

- See Decision 12 and task 4b.8 for the illustration. `role="img"` with a
  title tag provides the accessible name.
- Empty-state CTA is the same primary button as the toolbar's; selecting
  either opens the add-dialog (§2).

### 1.3 Populated

```
+----------------------------------------------------------------+
|   Datasources                                 [+ Add datasource]|
|                                                                |
|   +------------------------+  +------------------------+       |
|   | [☁] Marketing Drive    |  | [▣] S3 archive-prod    |       |
|   |     Google Drive       |  |     Amazon S3          |       |
|   |  ● connected           |  |  ● paused              |       |
|   |  Last sync 3m ago      |  |  Last sync 2d ago      |       |
|   |  1,248 items           |  |  472,910 items         |       |
|   |  [█████░░░░░] 48 GB    |  |  (no usage bar — S3)   |       |  <- quota-capable only
|   |                    [⋯] |  |                    [⋯] |       |  <- quick-actions
|   +------------------------+  +------------------------+       |
|                                                                |
|   +------------------------+  +------------------------+       |
|   | [☁] Personal OneDrive  |  | [☁] Research Drive     |       |
|   |     OneDrive           |  |     Google Drive       |       |
|   |  ◐ syncing             |  |  ✕ error               |       |
|   |  Last sync Just now    |  |  Last sync 6h ago      |       |
|   |  8,122 items           |  |  443 items             |       |
|   |  [███░░░░░░░] 12 GB    |  |  Refresh token expired |       |  <- errorReason row
|   |                    [⋯] |  |                    [⋯] |       |
|   +------------------------+  +------------------------+       |
|                                                                |
+----------------------------------------------------------------+
```

- Grid: `grid gap-3`, cards flex-wrap to minimum of 320px each (Decision 8
  density).
- Card order matches the order of `DatasourceSummary[]` returned by `list()`
  (spec.md Requirement: Datasource card surfaces the standardized summary
  fields).

### 1.4 Error

```
+----------------------------------------------------------------+
|   Datasources                                 [+ Add datasource]|
|                                                                |
|   +--------------------------------------------------------+   |
|   | ⚠ Unable to load datasources                           |   |  <- role="alert"
|   |                                                        |   |
|   |  We couldn't reach the main process.                   |   |
|   |  [Retry]                                               |   |
|   +--------------------------------------------------------+   |
|                                                                |
+----------------------------------------------------------------+
```

- Panel carries `role="alert"` so screen-readers announce it on mount.
- Retry re-invokes `list()`; a successful response transitions back to
  `populated` or `empty`.

---

## 2. Card anatomy

The `DatasourceCard` is the load-bearing visual unit of the dashboard. Every
field is annotated below. The component lives at
`apps/desktop/src/renderer/src/features/datasources/card.tsx` (task 5.4).

```
+--------------------------------------------------------------+
|  [icon]  Display name                         [status pill]  |  <- header row
|          Provider display name                               |
+--------------------------------------------------------------+
|  Last sync <relative time>     1,248 items                   |  <- meta row (tabular-nums)
+--------------------------------------------------------------+
|  [█████████░░░░░░] 48 GB of 100 GB                           |  <- usage bar (conditional)
+--------------------------------------------------------------+
|  Refresh token expired. Reconnect to resume syncing.         |  <- errorReason (conditional)
+--------------------------------------------------------------+
|                                                       [⋯]    |  <- quick-actions trigger
+--------------------------------------------------------------+
```

### 2.1 Element reference

| Region           | Source of truth                                                               | Notes |
|------------------|-------------------------------------------------------------------------------|-------|
| Provider icon    | `providers[summary.providerId].icon` → `Icon` adapter                         | 16px, `aria-hidden="true"` |
| Display name     | `summary.displayName`                                                         | Truncated with `text-ellipsis`; full name in tooltip |
| Provider name    | `providers[summary.providerId].displayName`                                   | `text-xs text-muted-foreground` |
| Status pill      | `summary.status` → shadcn `Badge` variant + coloured dot                      | `aria-label="Status: <status>"` (or `"Status: error — <reason>"`) |
| Last sync        | `summary.lastSyncAt` → relative formatter ("Just now", "3m ago", "Never synced") | `tabular-nums` |
| Item count       | `summary.itemCount` → `Intl.NumberFormat`                                     | `tabular-nums` |
| Usage bar        | `summary.usage` **AND** `providers[id].capabilities.quota === true`           | shadcn `Progress`, `role="progressbar"` |
| Error reason     | `summary.errorReason` **AND** `summary.status === "error"`                    | `text-destructive text-sm` |
| Quick-actions    | `DropdownMenu` (Radix)                                                        | See §2.2 |

### 2.2 Quick-actions menu (connected)

```
[⋯] ─┬─> Sync now          ↻
     ├─> Pause              ⏸
     ├─> Upload from local  ⬆
     ├─> Settings           ⚙
     └─> Remove             🗑  (destructive styling)
```

When `summary.status === "paused"`, the "Pause" item flips to "Resume" (▶).

All items carry a `lucide-react` glyph per Decision 15. Label text is the
accessible name (icon is `aria-hidden`). Menu is keyboard-navigable (↑↓ Enter
Esc) via Radix `DropdownMenu`.

### 2.3 Visual-refinement contract

- Root carries `p-4` (Decision 8), `gap-3` between rows. No `rounded-lg` or
  larger — `rounded-md` ceiling enforced by `scripts/radii-ceiling.test.ts`.
- No `backdrop-blur-*` on the card (glass is overlays-only, Decision 11).
- The syncing-status dot is an SVG `<circle>` with
  `motion-safe:animate-sync-pulse` — never `animate-sync-pulse` bare, so OS
  reduce-motion (or the Motion Safe toggle, Decision 10) suppresses it.

---

## 3. Add-datasource dialog wireframes

Two-step state machine: `pick → credentials`. Cross-reference Decision 3
(provider-abstraction-as-descriptor) and spec.md Requirement:
"Add-datasource flow uses a provider-agnostic step sequence."

### 3.1 Step 1 — Provider picker

```
┌───────────────────────────── Add datasource ──────────────────────────┐
│  Choose a provider                                                    │
│                                                                       │
│   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐           │
│   │  [☁]          │   │  [☁]          │   │  [▣]          │           │
│   │  Google Drive │   │  OneDrive     │   │  Amazon S3    │           │
│   │  OAuth        │   │  OAuth        │   │  Access key   │           │
│   └───────────────┘   └───────────────┘   └───────────────┘           │
│                                                                       │
│                                                       [Cancel]        │
└───────────────────────────────────────────────────────────────────────┘
```

- Options iterate `Object.values(providers)` — a fourth entry in the frozen
  registry surfaces here with zero dialog edits (extensibility, §5).
- Each tile is a focusable button with `data-testid="provider-option-<id>"`.

### 3.2 Step 2a — OAuth credential form (Google Drive, OneDrive, …)

```
┌──────────────────────── Add datasource ───────────────────────────────┐
│  [← Back]                             Google Drive                    │
│                                                                       │
│   Connect your Google Drive account to start syncing.                 │
│                                                                       │
│   [ Connect ]                                                         │  <- kicks off OAuth
│                                                                       │     (mocked delay)
│                                                       [Cancel]        │
└───────────────────────────────────────────────────────────────────────┘
```

- Single primary button. Pressing it resolves (mocked) after `delayMs`
  (default 800ms; tests inject 0). On resolve, `add({providerId, credentials})`
  is dispatched.

### 3.3 Step 2b — AWS access-key credential form (Amazon S3)

```
┌──────────────────────── Add datasource ───────────────────────────────┐
│  [← Back]                             Amazon S3                       │
│                                                                       │
│   Access key ID       [ AKIAIOSFODNN7EXAMPLE         ]                │
│   Secret access key   [ ••••••••••••••••••••••••••• ]                 │
│   Bucket name         [ archive-prod                 ]                │
│   Region              [ us-east-1                    ]                │
│                                                                       │
│                                       [Cancel]  [Add datasource]      │
└───────────────────────────────────────────────────────────────────────┘
```

- Four `Label` + `Input` pairs. Required-field validation on submit.
- Secret input uses `type="password"`.

### 3.4 Step 2c — Custom credential form (placeholder for new schemas)

```
┌──────────────────────── Add datasource ───────────────────────────────┐
│  [← Back]                             <Provider display name>         │
│                                                                       │
│   Credentials (JSON)                                                  │
│   ┌─────────────────────────────────────────────────────────────┐     │
│   │ {                                                           │     │
│   │   "apiKey": ""                                              │     │
│   │ }                                                           │     │
│   └─────────────────────────────────────────────────────────────┘     │
│   ⚠ Parse error at line 2 col 12  (if parse fails)                    │
│                                                                       │
│                                       [Cancel]  [Add datasource]      │
└───────────────────────────────────────────────────────────────────────┘
```

- Textarea + inline JSON parse. Used as an escape hatch for providers whose
  `credentialsSchema` is `"custom"` until a dedicated form is written.

---

## 4. Diagnostics view

The diagnostics route (`/diagnostics`, accessible via `Ctrl/Cmd + Shift + D`
— see Decision 4) is intentionally minimal. It exists to verify the IPC round
trip, not to demo UI.

```
+----------------------------------------------------------------+
|   Diagnostics                                                  |
|                                                                |
|   IPC ping:  ok — 2026-04-19T16:52:03.412Z                     |
|                                                                |
+----------------------------------------------------------------+
```

Single line of text emitted by `window.api.ping()` on mount. No other
affordances. Keeping it reachable (rather than deleted) preserves the
wiring-verification story per Decision 4.

---

## 5. Card state machine

`summary.status` is one of four values. Transitions are driven by IPC
responses — the renderer never mutates status locally. Channels from
`DATASOURCES_CHANNELS` in `packages/ipc-contracts/src/datasources.ts`.

```
                       ┌────────────────────────────────┐
                       │                                │
                       │      ( no datasource )         │
                       │                                │
                       └─────────────┬──────────────────┘
                                     │
                        add / credentials valid
                        → DATASOURCES_CHANNELS.add
                                     │
                                     ▼
               ┌───────────────────────────────────────────┐
               │                                           │
  ┌──────────> │               connected                   │ <──────────┐
  │            │                                           │            │
  │            └───┬───────────────┬───────────────┬───────┘            │
  │                │               │               │                    │
  │       action:"sync-now"    action:"pause"    provider error         │
  │       → channels.action   → channels.action  emitted via list()     │
  │                │               │               │                    │
  │                ▼               ▼               ▼                    │
  │            ┌───────┐       ┌────────┐       ┌───────┐               │
  │            │syncing│       │ paused │       │ error │               │
  │            └───┬───┘       └───┬────┘       └───┬───┘               │
  │                │               │                │                   │
  │       sync-now completes       │        action:"sync-now" OR        │
  │       → summary refreshed      │        re-add credentials          │
  │         via next list()        │                │                   │
  │                │               ▼                │                   │
  │                │         action:"resume"        │                   │
  │                │         → channels.action      │                   │
  │                │               │                │                   │
  └────────────────┴───────────────┴────────────────┘                   │
                                                                        │
              datasources:remove ──────────────────────────> ( gone ) ──┘
              → channels.remove
```

### IPC event reference

| From state       | Trigger                                                  | Channel                                                | To state      |
|------------------|----------------------------------------------------------|--------------------------------------------------------|---------------|
| (none)           | User completes add-dialog                                | `DATASOURCES_CHANNELS.add`                             | `connected`   |
| `connected`      | Quick-action "Sync now"                                  | `DATASOURCES_CHANNELS.action` with `action:"sync-now"` | `syncing`     |
| `connected`      | Quick-action "Pause"                                     | `DATASOURCES_CHANNELS.action` with `action:"pause"`    | `paused`      |
| `connected`      | Provider reports failure (next `list()` resolve)         | `DATASOURCES_CHANNELS.list` (summary field)            | `error`       |
| `syncing`        | Sync completes (handler returns updated summary)         | handler response on `DATASOURCES_CHANNELS.action`      | `connected`   |
| `syncing`        | Sync fails                                               | handler response on `DATASOURCES_CHANNELS.action`      | `error`       |
| `paused`         | Quick-action "Resume"                                    | `DATASOURCES_CHANNELS.action` with `action:"resume"`   | `connected`   |
| `error`          | Quick-action "Sync now" (retry)                          | `DATASOURCES_CHANNELS.action` with `action:"sync-now"` | `syncing`     |
| any              | Quick-action "Remove"                                    | `DATASOURCES_CHANNELS.remove`                          | (gone)        |
| any              | Upload quick-action                                      | `DATASOURCES_CHANNELS.upload` + `uploadProgress` events| status unchanged |

Uploads emit progress on `DATASOURCES_CHANNELS.uploadProgress`
(`DatasourcesUploadProgressEvent` shape); they do not change the card's
`status`. Upload success/failure is surfaced via a toast, not by mutating
the summary.

---

## 6. Accessibility — WCAG 2.2 AA

The primitive layer (shadcn + Radix) is doing most of the a11y work; feature
code inherits it. The enumerated guarantees:

### 6.1 Keyboard navigation

- **Dashboard → Add-datasource trigger:** reachable by Tab in DOM order.
- **Cards:** the quick-actions menu trigger is focusable; Enter/Space opens
  the Radix `DropdownMenu`, ↑/↓ moves focus within menu items, Esc closes
  and restores focus to the trigger.
- **Dialog:** Radix `Dialog` implements focus-trap. Tab cycles within the
  dialog; Shift+Tab reverses. Esc closes; `onCloseAutoFocus` returns focus
  to the opener (see `AddDatasourceDialog`'s `openerRef` wiring, task 6.3).
- **Theme switcher:** button + dropdown, same semantics as card quick-actions.
- **Diagnostics:** reachable via `Ctrl/Cmd + Shift + D` without a visible
  nav item.

### 6.2 ARIA + semantics

- `Dialog`: `role="dialog"` + `aria-modal="true"` + `aria-labelledby` bound
  to the title.
- `DropdownMenu`: `role="menu"` + `role="menuitem"` children.
- Status badge: `aria-label="Status: <status>"` (non-color status signal).
- Error panel: `role="alert"`.
- Progress bar: `role="progressbar"` with `aria-valuenow` / `aria-valuemax`.
- Provider and status icons: `aria-hidden="true"` (label text is the name).
- Empty-state illustration: `role="img"` with accessible name.

### 6.3 Contrast

- All foreground/background token pairs in `:root`, `.dark`, and
  `[data-theme="serene-blue"]` meet WCAG 2.2 AA (4.5:1 for body text,
  3:1 for large text and non-text interactive elements).
- Focus rings use `--ring` at >=3:1 contrast against every surface they
  appear on.
- Status colours (green / amber / zinc / red) are **redundant with a label
  or icon shape** — colour is never the sole signal of status.

### 6.4 Motion

- Every custom animation (`animate-sync-pulse`, `animate-sync-ripple`,
  `animate-skeleton-shimmer`) is gated by the Motion Safe preference
  (Decision 10). Default is always-on; enabling Motion Safe restores OS
  `prefers-reduced-motion` respect.
- Every shadcn primitive animation (Dialog fade/zoom, DropdownMenu slide,
  Tooltip fade) uses Tailwind's `motion-safe:` variant — OS-level
  reduce-motion suppresses them independent of the Motion Safe toggle.
- Guardrails: `scripts/motion-budget.test.ts` enforces the animation
  whitelist; `components/ui/__tests__/reduced-motion.test.tsx` enforces
  `motion-safe:` on primitive motion tokens.

---

## 7. Adding a new provider

This section is the **extensibility contract**. Decision 3 promises that
a fourth provider is "a new entry in a `providers` registry plus a
credential form — not a UI rewrite." That promise is codified here.

### 7.1 The `ProviderDescriptor` shape

Copied verbatim from `packages/ipc-contracts/src/datasources.ts`:

```ts
export type CredentialsSchema = "oauth" | "aws-access-key" | "custom";

export interface ProviderCapabilities {
  quota: boolean;       // provider exposes storage quota
  oauth: boolean;       // registration uses an OAuth flow
  directUpload: boolean;// UI exposes a local-file upload action
}

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  icon: string;                     // IconName resolved by the Icon adapter
  capabilities: ProviderCapabilities;
  credentialsSchema: CredentialsSchema;
}

export const providers = {
  "google-drive": { /* ... */ },
  onedrive:       { /* ... */ },
  "amazon-s3":    { /* ... */ },
} as const satisfies Record<string, ProviderDescriptor>;

export type ProviderId = keyof typeof providers;
```

The registry is **frozen** (`as const satisfies …`). Adding a provider is
an edit to the registry, not a runtime mutation.

### 7.2 Worked example — adding Dropbox

Dropbox uses OAuth (same shape as Google Drive and OneDrive), exposes a
quota, and supports direct upload. It re-uses the existing `OAuthForm`
component — **no new credential form is required**.

#### Step 1 — Extend the registry

Edit `packages/ipc-contracts/src/datasources.ts`:

```ts
export const providers = {
  "google-drive": {
    id: "google-drive",
    displayName: "Google Drive",
    icon: "cloud",
    capabilities: { quota: true, oauth: true, directUpload: true },
    credentialsSchema: "oauth",
  },
  onedrive: {
    id: "onedrive",
    displayName: "OneDrive",
    icon: "cloud",
    capabilities: { quota: true, oauth: true, directUpload: true },
    credentialsSchema: "oauth",
  },
  "amazon-s3": {
    id: "amazon-s3",
    displayName: "Amazon S3",
    icon: "database",
    capabilities: { quota: false, oauth: false, directUpload: true },
    credentialsSchema: "aws-access-key",
  },
  // ── new ──
  dropbox: {
    id: "dropbox",
    displayName: "Dropbox",
    icon: "cloud",                                    // reuse existing IconName
    capabilities: { quota: true, oauth: true, directUpload: true },
    credentialsSchema: "oauth",                       // reuses OAuthForm
  },
} as const satisfies Record<string, ProviderDescriptor>;
```

That single edit is enough to make the provider picker list Dropbox, route
the user to the existing OAuth form in step 2 of the dialog, and show a
quota usage bar on Dropbox cards once real data flows. The type-level
contract test in `packages/ipc-contracts/src/__tests__/datasources.test-d.ts`
(task 1.1) will need its `providers` keys expanded — that is the only test
a new provider is required to touch.

#### Step 2 — Check `credentialsSchema`

The three built-in forms handle:

| Schema               | Form component                                                                 | When to reuse |
|----------------------|--------------------------------------------------------------------------------|---------------|
| `"oauth"`            | `features/datasources/credential-forms/oauth-form.tsx`                         | Any OAuth-backed provider (Google Drive, OneDrive, Dropbox, Box, …) |
| `"aws-access-key"`   | `features/datasources/credential-forms/aws-access-key-form.tsx`                | Any S3-compatible access-key flow (AWS S3, MinIO, Wasabi, …) |
| `"custom"`           | `features/datasources/credential-forms/custom-form.tsx`                        | Placeholder — a JSON textarea. Use while prototyping a new schema. |

Dropbox uses OAuth → **reuse `OAuthForm`, no new file.**

#### Step 3 — If the schema is new

If a hypothetical provider needs a bespoke form (say, a GitLab personal
access token), the steps are:

1. Add a new literal to `CredentialsSchema` in
   `packages/ipc-contracts/src/datasources.ts`:

   ```ts
   export type CredentialsSchema = "oauth" | "aws-access-key" | "custom" | "pat-token";
   ```

2. Create `features/datasources/credential-forms/pat-token-form.tsx`
   exporting a component with the same `{ descriptor, onSubmit, onCancel }`
   prop contract as the existing forms.

3. Extend the exhaustive-switch dispatch in `add-dialog.tsx`. The switch is
   `assertNever`-typed at the default branch, so TypeScript will refuse to
   compile until the new case is handled — the one-edit site is self-locating.

4. Update the `add-dialog-extensibility.test.tsx` fixture if it asserts the
   schema set.

#### Step 4 — Main-process handler (future phase)

The main-process side is **out of scope** for this change. The seam is:

- `apps/desktop/src/main/ipc/datasources/add.ts` receives
  `DatasourcesAddRequest` with the new `providerId`.
- It dispatches on `providerId` to a provider-module
  (e.g. `apps/desktop/src/main/ipc/datasources/dropbox.ts`) — that module
  is the only place that imports the provider SDK.
- The renderer-side `app-shell` import-ban (Decision 2 rationale; enforced
  by `scripts/provider-sdk-ban.test.ts`, task 9.2) guarantees the SDK
  never crosses into the renderer bundle.

The handler-dispatch implementation lands in a follow-up change; adding the
descriptor entry in Step 1 now does not require the handler to exist
(the mocked `add` handler accepts any registered `providerId`).

### 7.3 What does NOT change

This is the extensibility guarantee:

- `features/datasources/dashboard.tsx` — unchanged.
- `features/datasources/card.tsx` — unchanged. (Usage-bar visibility is
  driven by `capabilities.quota`, status is driven by the response summary
  — no per-provider branching.)
- `features/datasources/add-dialog.tsx` — unchanged **unless** the
  `CredentialsSchema` union grew (Step 3 above).
- `features/datasources/provider-picker.tsx` — unchanged; iterates
  `Object.values(providers)`.
- `features/datasources/store.tsx` — unchanged.
- `components/ui/**` — unchanged.

The extensibility contract is tested by
`features/datasources/__tests__/add-dialog-extensibility.test.tsx` (task 6.2)
— it injects a 4th fixture provider into the registry and asserts no
`providerId === "..."` branches exist in the dialog or picker source.

---

## 8. Cross-references

| Topic                                          | Authoritative source                                                          |
|------------------------------------------------|-------------------------------------------------------------------------------|
| Four-layer IPC rule (why mocks still use IPC)  | `design.md` Decision 2                                                        |
| Provider abstraction (descriptor + registry)   | `design.md` Decision 3                                                        |
| Dashboard is the home view                     | `design.md` Decision 4; `spec.md` Requirement "Main window home view …"       |
| Store shape (Context + reducer, no library)    | `design.md` Decision 5                                                        |
| Theme switcher + three themes                  | `design.md` Decisions 6, 17, 18                                               |
| Upload uses main-process file picker           | `design.md` Decision 7; `spec.md` Requirement "Upload action uses …"          |
| Visual direction (Linear/Vercel dense-quiet)   | `design.md` Decisions 8–12; `spec.md` Requirement "Visual direction …"        |
| Motion budget + Motion Safe toggle             | `design.md` Decision 10                                                       |
| Glass on overlays                              | `design.md` Decision 11                                                       |
| App-chrome (header + footer)                   | `design.md` Decision 14                                                       |
| Primary-action glyphs                          | `design.md` Decision 15                                                       |
| Ambient watermark                              | `design.md` Decision 16                                                       |
| Card field shape                               | `spec.md` Requirement "Datasource card surfaces the standardized summary fields" |
| Add-dialog step sequence                       | `spec.md` Requirement "Add-datasource flow uses a provider-agnostic step sequence" |
| IPC surface (channel names, request/response)  | `packages/ipc-contracts/src/datasources.ts`                                   |

---

_End of document. If you edited a binding artifact, refresh the
"Last updated" stamp at the top and record the review round._
