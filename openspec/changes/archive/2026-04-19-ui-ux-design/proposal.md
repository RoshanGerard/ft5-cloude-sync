## Why

The archived `setup-project` change landed the walking skeleton — one `BrowserWindow`, the `ping` IPC, four-layer wiring — but the renderer is literally one page that prints the ping timestamp. There is no UI, no design language, no dashboard, and no visible surface area for the app's actual purpose: managing local-to-cloud file sync across multiple datasources (Google Drive, OneDrive, Amazon S3, and anything else a later provider plugin adds).

Before any real sync feature (OAuth, provider SDKs, sync engine, file watchers) can land, we need:

1. A **design language** — tokens (colors, spacing, type), a small set of baseline primitives (buttons, cards, inputs, dialogs, menus, status indicators), and a11y defaults (keyboard nav, focus rings, contrast) — so every future feature is not re-inventing chrome.
2. A **main-window dashboard** that represents the app's core mental model: a list of registered datasources with per-datasource status, usage, and row-level actions. This is the first screen a user sees after launch and the thing they return to constantly.
3. A **provider-agnostic datasource abstraction on the renderer** (and the IPC seam backing it) so adding a fourth provider later touches a provider descriptor, not the UI. Google Drive, OneDrive, and S3 are concrete reference providers but the UI treats them as instances of a common type.
4. A **mocked but architecturally-correct data path** — the renderer reads datasource state through `window.api.datasources.*`, same as any future real call. The handler in this change returns hard-coded mock data; the real-provider follow-up change swaps the handler implementation without touching the preload contract or the renderer.

Postponing this until after real providers land is the wrong order: we'd either build providers against an undefined UI (and refactor on contact) or build the UI against real providers (and couple shipping to OAuth credentials we don't have yet). Scaffolding first, with mocked data, is the smaller irreversible commitment.

## What Changes

- **New capability `datasources-ui`** (see `specs/datasources-ui/spec.md` delta) defining:
  - The main window SHALL render a datasources dashboard as the home view (empty-state, populated-state, loading-state all specified).
  - Each registered datasource SHALL be represented by a card surfacing: connection status (connected / syncing / paused / error), storage usage where the provider exposes a quota, last-sync timestamp and item counts, a local-file upload affordance, and row-level quick actions (pause / sync now / settings / remove).
  - An add-datasource flow SHALL let the user pick a provider (Google Drive, OneDrive, Amazon S3) and complete registration through a provider-agnostic step sequence; adding a fourth provider type SHALL require only a new provider descriptor, no UI changes.
  - All datasource reads and writes SHALL go through a `window.api.datasources.*` IPC surface. The renderer SHALL NOT import any provider SDK or OS/net primitive directly. This requirement holds even for mocked data.
- **Renderer scaffolding** — the `@ft5/renderer` workspace gains:
  - shadcn/ui initialized (`npx shadcn@latest init`) against Tailwind v4 with the **"new-york" style** and **"slate" base colour**, shipping BOTH the default light ("white") and dark themes as CSS variables gated by a `.dark` class on `<html>`. Tokens cover colours, spacing, radii, and type per shadcn's defaults.
  - A generated primitive set from the shadcn registry: `button`, `card`, `badge`, `dialog`, `dropdown-menu`, `progress`, `tooltip`, `input`, `label`, `skeleton`, and `sonner` (toasts). Components live under `components/ui/` as in-repo source — owned, audited, customizable.
  - A theme switcher in the dashboard toolbar (Light / Dark / System) persisted to `localStorage`, with a pre-paint inline script that sets the initial `.dark` class before React mounts (prevents flash of wrong theme).
  - Icon wrapper component (`lucide-react` via a single `Icon` adapter so the concrete library is swappable).
  - **Visual refinement layer targeting a Linear/Vercel dense-quiet flavour (design.md Decisions 8–12):** density overrides tightening shadcn defaults (`text-sm` base body, `p-4` cards, `rounded-md` ceiling); Geist Sans variable font for UI + Geist Mono for numerics, with `tabular-nums` on all numeric card fields; a CSS-only motion budget bounded to a named surface table (dialog/menu/tooltip open-close, syncing pulse, skeleton shimmer, card hover) with full `prefers-reduced-motion` respect; `backdrop-blur` glass surfaces applied ONLY to Dialog scrim and DropdownMenu content (cards and base chrome remain opaque); a custom inline monochrome-plus-accent SVG illustration for the empty state.
  - `DatasourcesDashboard` page as the new home route; the existing ping probe moves to a developer-only diagnostics view, not the home.
  - `AddDatasourceDialog` with a provider-picker step and provider-specific credential step (Google Drive + OneDrive mocked OAuth, S3 mocked access-key form). The mocked flows return success and produce a new card immediately.
  - A client-side store (React Context + `useSyncExternalStore`-compatible shape, no external state library) that mirrors the IPC response and optimistically updates on user actions.
- **IPC scaffolding** — `packages/ipc-contracts/` gains typed `DatasourcesListRequest`/`Response`, `DatasourcesAddRequest`/`Response`, `DatasourcesRemoveRequest`/`Response`, `DatasourcesActionRequest`/`Response` (pause, resume, sync-now), and a `DatasourceSummary` shape covering all card fields including optional quota. `apps/desktop/src/main/ipc/datasources/` gains handlers that return in-memory mocked data. Preload exposes `window.api.datasources.{list,add,remove,action,upload}`. The four-layer rule is respected end-to-end.
- **Documentation** — a new `docs/design/datasources-ui.md` captures wireframes (ASCII / Markdown), interaction flows, the provider descriptor shape, the card state machine, and accessibility requirements. This is where the visual design lives; `spec.md` stays behavioural.

## Capabilities

### New Capabilities

- `datasources-ui`: the main-window dashboard that lists registered datasources, the add-datasource flow across Google Drive / OneDrive / Amazon S3 via a provider-agnostic abstraction, and the `window.api.datasources.*` IPC surface backing both. Implemented with mocked provider responses in this change; the renderer and IPC contract are the shipping shape.

### Modified Capabilities

- `app-shell`: the main window now loads the datasources dashboard as its default view instead of the ping probe. The existing `app-shell` requirements (single `BrowserWindow`, hardened `webPreferences`, four-layer IPC, renderer import bans) are preserved; only the default route changes. The spec delta captures this as a modification to the "Desktop app launches with a single main window" requirement's scenario text — `ping` remains available for end-to-end wiring verification, but no longer owns the home route.

## Impact

- **Code**: `apps/desktop/src/renderer/src/` gains `app/page.tsx` (dashboard) replacing the ping probe, `components/` (primitives), `features/datasources/` (dashboard + card + add-dialog + store), `styles/` (tokens, global CSS). `apps/desktop/src/main/ipc/datasources/` gains handlers. `apps/desktop/src/preload/` gains the `datasources` exposure. `packages/ipc-contracts/src/datasources.ts` gains the contract types and a `test-d.ts` type-assertion test.
- **Docs**: `docs/design/datasources-ui.md` new. README unchanged.
- **Dependencies (production, renderer)**: `tailwindcss` v4, `@radix-ui/react-{dialog,dropdown-menu,progress,tooltip,slot}`, `lucide-react`, `clsx`, `class-variance-authority`, `tailwind-merge`, `sonner` — all pulled in by `npx shadcn@latest init` + the per-component `shadcn add` runs. shadcn/ui itself is NOT a runtime dependency; it's a generator that writes in-repo source files under `components/ui/`. Plus `geist` (the npm package that ships Geist Sans + Mono variable fonts) loaded via `next/font` — adds ~115 KB of preloaded font weight, justified in `design.md` Decision 9. Each dep is justified in `design.md` Decisions 1 and 9 with rejected alternatives. No state library is added; React Context + hooks are sufficient for mocked data. NO motion library is added; motion is CSS-only (Decision 10).
- **Dependencies (dev)**: `@testing-library/react` and `@testing-library/jest-dom` are already in root dev deps. No new test deps.
- **CI**: existing `pnpm -w test` + `pnpm typecheck` + `pnpm lint` steps cover the new code. No workflow edits.
- **Tests**: new Vitest (jsdom) tests for the primitives, dashboard rendering across states, add-flow happy path per provider, and the IPC contract type-assertion test. Target: >90% line coverage on `features/datasources/` and 100% on primitives' variant props.
- **Security**: no change to Electron hardening. Tokens and primitives are render-only. The add-flow's mocked OAuth does NOT embed any real OAuth view in this change — the real OAuth dance is a later change with its own security review.
- **Out of scope** (deferred, explicit):
  - Real OAuth for Google Drive and OneDrive (separate change, needs credential provisioning).
  - Real Amazon S3 credentials storage (separate change, needs the keychain / OS credential manager decision).
  - Real sync engine, auto-sync, scheduled sync — all downstream of this change.
  - File monitor service (`services/fs-monitor`) integration — receives events from this UI via a later change.
  - Persistence of registered datasources to SQLite — this change uses in-memory mocked state; a follow-up adds the Drizzle schema and wires the handlers to it.
  - Internationalization. Strings are English-only with a single call-site pattern so `i18n` can be retrofitted.
  - Telemetry / analytics on UI interactions.
