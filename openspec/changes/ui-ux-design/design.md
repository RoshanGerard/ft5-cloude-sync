## Context

The renderer today is `apps/desktop/src/renderer/src/app/page.tsx` — 22 lines that render `window.api.ping()` output. No styling, no components, no routing, no data shape beyond `{ ok, ts }`. The real product surface — registered datasources with status + usage — has zero representation.

The app's domain: a user registers one or more cloud datasources (Google Drive via OAuth, OneDrive via OAuth, Amazon S3 via access key + secret). Each datasource is then an ongoing sync target: status fluctuates (connected ↔ syncing ↔ paused ↔ error), usage drifts (bytes used of quota, where the provider exposes a quota — S3 doesn't), sync activity is visible (last-sync timestamp, item counts, error reason). The user operates on them row-at-a-time (pause / resume / sync-now / upload a local file / open settings / remove).

This change scaffolds the UI and the IPC seam backing it. Real provider integration is downstream.

## Goals / Non-Goals

**Goals:**
- A contributor opening the packaged app sees the datasources dashboard, not a timestamp.
- The renderer code is structured so that the day a real Google Drive OAuth handler lands in `src/main/ipc/datasources/google-drive.ts`, the UI code does not have to change — only the handler's return shape becomes real instead of mocked.
- The visual design system is small enough to hand-audit (tokens, nine primitives, one icon adapter) and opinionated enough that feature work doesn't reinvent chrome.
- Accessibility defaults (keyboard nav, focus management, ARIA on dialogs/menus, contrast) are baked into the primitives, not bolted on per-screen.
- Adding a fourth provider (say, Dropbox) is a new entry in a `providers` registry plus a credential form — not a UI rewrite.

**Non-Goals:**
- Building real OAuth flows. The Google Drive and OneDrive "Connect" buttons in this change open a mocked dialog that returns a success result after a short delay.
- Building the real S3 credential form's validation (region enumeration, endpoint detection, etc). The mocked form accepts any non-empty inputs.
- Persisting registered datasources. In-memory state only, resets on app relaunch.
- Animations beyond basic focus/hover transitions and a loading spinner. Motion design comes later if we find we want it.
- Custom theming beyond what shadcn/ui ships. The default shadcn light (white) and dark themes are in scope; additional brand themes, accent-colour customisation, or a token-editor UI are out of scope.
- Internationalization infrastructure. Strings are plain English; a single `ui/strings.ts` call-site pattern is established so an `i18n` retrofit is mechanical.
- Real upload. The "Upload from local" action opens a mocked file picker and shows a mocked progress indicator; no bytes move.

## Decisions

### Decision 1: shadcn/ui with both light (white) and dark themes

**Chosen:** Initialize shadcn/ui in the renderer workspace (`npx shadcn@latest init`) selecting the **"new-york" style** and **"slate" base colour** (both chosen for their alignment with the Linear/Vercel dense-quiet visual direction established in Decision 8). Generate the primitive set we need (`button`, `card`, `badge`, `dialog`, `dropdown-menu`, `progress`, `tooltip`, `input`, `label`, `skeleton`, `sonner` for toasts). Use shadcn/ui's default theme tokens, which ship BOTH a light ("white") and a dark theme as CSS variables keyed off a `.dark` class on `<html>`. Keep both themes available; respect `prefers-color-scheme` on first load and expose a user-facing theme switcher (light / dark / system).

Underlying stack shadcn pulls in (all justified): `tailwindcss` v4, `@radix-ui/react-{dialog,dropdown-menu,progress,tooltip,slot}`, `lucide-react`, `clsx`, `class-variance-authority`, `tailwind-merge`, `sonner`. Components live in `apps/desktop/src/renderer/src/components/ui/` — in-repo source, not a dependency, so we own customization and can audit every line.

**Rationale:**
- shadcn/ui gets us a vetted, a11y-correct, Radix-backed component surface without hand-rolling focus traps, keyboard handling, or ARIA wiring. The components are copy-paste so we keep full ownership of source — no black-box dependency, no version-upgrade blast radius.
- Both the light ("white") and dark themes are part of shadcn's default install. Getting both out of the box is strictly more capable than a custom single-theme design, at no additional effort.
- The token layer (`:root { --background: ... }` for light, `.dark { --background: ... }` for dark) is exactly the CSS-variable structure we would have built by hand. Tailwind utilities resolve against those variables, so feature code writes `bg-background` and gets the right colour per theme automatically.
- shadcn primitives are already-built. We ship the dashboard faster and spend our effort on the product surfaces (cards, dialog flows, store) instead of re-implementing `Button` and `Dialog`.
- Everything shadcn generates is plain TypeScript + Tailwind in our repo. When we want to customize a primitive's behaviour or styling, we edit the file directly — there's no upstream to fight.

**Alternatives considered:**
- *Hand-rolled primitives over Radix + Tailwind (the pre-revision plan).* Rejected: more work for the same underlying behaviour, and shadcn's patterns are the community norm so contributor onboarding is cheaper.
- *Mantine or Chakra UI.* Rejected: each bundles a theming runtime, a state context, and an opinionated layout grammar. Shadcn is CSS-variable + Tailwind — no runtime, no hidden context.
- *MUI (Material UI).* Rejected: Material's visual language fights with a desktop-native feel, and its theming runtime is heavier than we need.
- *Ark UI or HeadlessUI.* Rejected: similar headless-primitive category to Radix, but shadcn's ecosystem standardises on Radix and we get the component library "for free" on top.
- *Tailwind-only, no component library.* Rejected: we still need the accessible overlay/menu/dialog primitives. Not building them on top of Radix was the option we already rejected.

### Decision 2: Datasource data flows through `window.api.datasources.*` even when mocked

**Chosen:** The handlers in `apps/desktop/src/main/ipc/datasources/` return hard-coded mock data in this change. The preload exposure, the `packages/ipc-contracts/` types, and the renderer call sites are the real, shipping shape.

**Rationale:**
- `openspec/project.md` architecture rule #3 says every renderer-callable operation must exist as four coordinated pieces (handler / contract / preload / call site). Skipping the IPC layer because "it's just mocks" violates the rule and creates a seam that would have to be retrofitted later — exactly when OAuth plumbing is also being built, maximum churn.
- Using IPC for mocks forces us to confront the contract shape now, when it's cheap. Fields that look fine in TypeScript often turn out wrong the moment they have to cross a structured-clone boundary.
- The handler-level swap (mocked → real) is a surgical change that doesn't touch the UI.

**Alternatives considered:**
- *Render mocks in the renderer directly, defer IPC until real providers.* Rejected: violates the four-layer rule, couples the UI to the mock shape, creates migration work later.
- *Mocks live in a shared package that both main and renderer import.* Rejected: the renderer importing a package that transitively imports `fs` or a provider SDK (even accidentally, via a future mock upgrade) defeats the `app-shell` import-ban. Mocks in the main process, consumed via IPC, stay on the correct side of the boundary.

### Decision 3: Provider abstraction is a descriptor + a handler, not a class hierarchy

**Chosen:** Define a `ProviderDescriptor` type with:
```ts
type ProviderDescriptor = {
  id: "google-drive" | "onedrive" | "amazon-s3" | string; // open for extension
  displayName: string;
  icon: IconName;
  capabilities: {
    quota: boolean;          // provider exposes storage quota
    oauth: boolean;          // registration uses OAuth flow
    directUpload: boolean;   // UI exposes local-file upload action
  };
  credentialsSchema: "oauth" | "aws-access-key" | "custom"; // picks the credential form
};
```
Each concrete provider is one entry in a frozen `providers` registry in `packages/ipc-contracts/src/datasources/providers.ts`. The renderer reads this registry to build the provider-picker and pick the right credential form. The main-process handler looks up the descriptor by `id` to dispatch to the right (currently mocked) provider module.

**Rationale:**
- Declarative > imperative for a small set of providers whose differences are in configuration, not behaviour. Three providers today, likely 6–10 long-term; a registry scales.
- The `capabilities` flags drive per-card UI conditionals — e.g. S3 cards hide the quota bar because `capabilities.quota === false`. UI branching against a typed capability flag is auditable; UI branching against `provider.id === 'amazon-s3'` is how conditionals rot.
- Keeps provider-specific UI (OAuth button vs access-key form) to exactly one file (`features/datasources/credential-forms/<schema>.tsx`), not sprinkled throughout.

**Alternatives considered:**
- *Abstract `ProviderAdapter` class with virtual methods.* Rejected: class hierarchies shine when behaviour differs; here the behaviour differs only in the provider-side code (OAuth URLs, API calls) which lives in main-process provider modules, not in the renderer abstraction. A class hierarchy in the renderer would be ceremony without payoff.
- *No abstraction — hard-code three providers in the UI.* Rejected: the first moment a fourth provider is added, the UI gains three conditionals and a fourth path. Over 18 months of provider additions that compounds into the thing we're trying to avoid.

### Decision 4: Home route = dashboard; ping moves to a dev-only diagnostics page

**Chosen:** Replace `apps/desktop/src/renderer/src/app/page.tsx` with the dashboard. Move the ping probe to `apps/desktop/src/renderer/src/app/diagnostics/page.tsx`, accessible only through a keyboard shortcut (`Ctrl/Cmd + Shift + D`) or a deep link (`app://./diagnostics`), not a visible nav item.

**Rationale:**
- The `app-shell` spec requires the ping round-trip for wiring verification — that's still exercised (the diagnostics page calls it on mount, and the existing Playwright e2e still hits it via a direct navigation). We are not removing `ping`, just demoting it from "thing the user sees on launch" to "thing the developer sees when debugging".
- Users should see the product, not a timestamp. The dashboard is the product.
- Keeping the diagnostics route reachable (not deleted) preserves the wiring-verification story and is cheap.

**Alternatives considered:**
- *Delete the ping page entirely and rely on the Playwright e2e only.* Rejected: the manual-debug-in-running-app use case has come up repeatedly during this project's short history; losing the live probe would hurt debugging.
- *Keep ping on `/` and put the dashboard on `/datasources`.* Rejected: the dashboard is the home. Every launch putting the user one click from where they want to be is chronic friction.

### Decision 5: Client-side datasource store = React Context + `useSyncExternalStore`-compatible hook, no external library

**Chosen:** `DatasourcesProvider` wraps the app, owns the datasource list state in `useState`, exposes `useDatasources()` and `useDatasourceActions()` hooks. Writes call `window.api.datasources.*`, then optimistically update local state, then reconcile with the IPC response. No Zustand, no Redux, no Jotai.

**Rationale:**
- For a mocked data path with a list of N = 3..20 items and fewer than a dozen mutations, a Context is adequate and has zero dep cost.
- The "swap to real providers" moment doesn't benefit from a state library — the bottleneck is provider integration, not state management.
- Introducing a state library now locks in a dependency before we know the access patterns. Easier to migrate later if the hooks start sprawling.

**Alternatives considered:**
- *Zustand.* Rejected for now: perfectly good choice but the rationale to add it isn't concrete. Revisit if cross-feature state sharing (e.g. a global toast queue fed from datasource events) gets tangled.
- *Redux Toolkit + RTK Query.* Rejected: overkill for the mutation surface this UI has.
- *TanStack Query.* Rejected: its server-state model is for HTTP resources with caching/invalidation; here "the server" is the main process over IPC, which we already control end-to-end. The async layer is thin enough to handle with `useEffect` + local state.

### Decision 6: Theme switcher ships with the dashboard (light / dark / system), backed by shadcn's `.dark` class toggle

**Chosen:** A theme-switcher control in the dashboard toolbar (icon-button with a dropdown menu: Light / Dark / System). Selection writes to `localStorage['ft5.theme']`; on load, a small inlined script resolves the effective theme (explicit preference overrides `prefers-color-scheme`) and sets or clears `.dark` on `<html>` before first paint to avoid a flash of wrong theme (FOUC). The inline script is the only renderer-side script that runs ahead of the React tree; it has no external dependencies.

**Rationale:**
- The user explicitly named both shadcn themes ("Shadcn Dark Theme, Shadcn White Theme") as a desired outcome. Shipping only system-follow would miss the explicit-selection half of that.
- The `.dark` class on `<html>` is shadcn's default idiom and matches how its tokens are wired. No custom theming runtime.
- `localStorage` is fine: the renderer already runs in a sandboxed origin unique to the packaged app, so there's no cross-site concern. It survives app restarts without touching the main process, and a later change can promote it to a main-process setting if we want cross-device sync.
- Pre-paint inline script is standard practice and is the only way to avoid FOUC on the first paint of the dark theme.

**Alternatives considered:**
- *System-follow only, no user toggle.* Rejected: user explicitly asked for both themes to be selectable.
- *Put the toggle in a Settings screen.* Rejected: no Settings screen exists yet in this change, and a theme preference is the kind of thing users expect to toggle from a top-level affordance, not buried.
- *Use `next-themes`.* Rejected: adds a dependency for behaviour that's 40 lines of hand-written code (read localStorage → set/clear `.dark` class → write back on change). The trade-off favours no extra dep.

### Decision 7: Upload-from-local uses `window.api.datasources.upload` with a mocked dialog; no real FS access in renderer

**Chosen:** The card's "Upload" quick action calls `window.api.datasources.upload({ datasourceId })`. The main process handler opens a native file-picker via `dialog.showOpenDialog`, stages the file(s), and (in this change) returns a mocked success result after a simulated progress stream delivered over a one-shot IPC event channel. No real bytes move.

**Rationale:**
- The renderer must not import `fs` or touch the OS file-picker directly. `dialog.showOpenDialog` lives in the main process; exposing it through an IPC handler is the only correct path.
- Establishing the progress-event channel now — even mocked — defines the contract the real uploader will use later. Progress events are a known-hard-to-retrofit piece; getting the shape right while it's cheap is worth the small cost.

**Alternatives considered:**
- *Defer the Upload action entirely until real sync lands.* Rejected: the user explicitly asked for it in the card's quick-actions set. Shipping the UI stub now means the real implementation is a one-file swap.
- *Use the web `<input type="file">` in the renderer.* Rejected: that dialog is a browser control with no native integration (no "open folder" on macOS, no drag-target from Finder/Explorer), and exposing `File` objects in the renderer still doesn't get us the paths we need for real sync.

### Decision 8: Visual direction — Linear/Vercel dense-quiet, keyboard-first

**Chosen:** The design targets a Linear/Vercel visual flavour: information-dense, visually quiet, keyboard-first. Concrete parameters:

- **Density:** card padding `p-4` (16px), dashboard gap between cards `gap-3` (12px), toolbar height 48px, body text size base `text-sm` (14px) with headings at `text-base`/`text-lg`. Tighter than shadcn's out-of-the-box defaults (which assume `text-base` body = 16px).
- **Radii budget:** nothing larger than `rounded-md` (6px) on routine surfaces (cards, buttons, badges, inputs). Dialog content may use `rounded-lg` (8px) for a slight silhouette against the overlay. No pill-shaped buttons. No fully-rounded cards.
- **Colour usage:** relies primarily on the neutral slate palette from shadcn. A single accent (the shadcn `primary` token) is used for call-to-action buttons, selected states, and active sync indicators. Status colours (green for connected, amber for syncing, zinc for paused, red for error) are used only in status pills and error surfaces — not as background fills of large areas.
- **Border + depth:** hairline borders (`border-border`, effectively 1px) do the separation work. Cards sit flat — no drop-shadow on base state. Elevation is introduced only on open overlays (Dialog, DropdownMenu) via the glass treatment in Decision 11.
- **Iconography:** `lucide-react` at consistent 16px within cards and 18px in toolbar affordances, via the `Icon` adapter.

**Rationale:**
- The reference flavour the user named is the "Linear/Vercel" class of product UIs — sharp, dense, quiet. Out-of-the-box shadcn is slightly softer than this target (default body at 16px, default card padding `p-6`). The parameters above are the minimal overrides needed to shift the feel.
- Dense-quiet is well-matched to a dashboard where the user is glancing at multiple datasource rows and wants high information yield per screen. Airy-spacious would waste the horizontal real estate we have.
- Keyboard-first means: every action in the quick-action menu is keyboard-reachable and labelled; the theme switcher is keyboard-operable; the add-dialog flows with Tab/Enter; a Command Palette would be a natural next change but is out of scope here.

**Alternatives considered:**
- *Keep shadcn defaults untouched (airier spacing, `text-base` body).* Rejected: would feel generic-Tailwind rather than Linear/Vercel. The density tweak is cheap and on-brand.
- *Apple/Raycast soft-and-spacious flavour.* Rejected by user preference. The two flavours are load-bearing opposites on density and motion; picking one and committing beats a hybrid.

### Decision 9: Typography — Geist Sans variable font with tabular numerics for numeric fields

**Chosen:** Load Geist Sans (variable) as the UI font and Geist Mono for monospace surfaces via `next/font/local` (or the `geist` npm package, evaluated in task 4.10 — both ship the same variable font files). Type scale shrinks one step from shadcn defaults: `text-sm` for body, `text-base` for section headings, `text-lg` for page title. All numeric card fields — storage usage numbers, item counts, last-sync timestamps — render with the Tailwind `tabular-nums` utility so digits don't jitter when values change.

**Rationale:**
- Geist is Vercel's production font; it's the typographic signature of the "Linear/Vercel flavour" the user named. Using it is the most direct way to deliver the feel, and it's MIT-licensed and available via `next/font` with zero external request at runtime.
- A variable font means we get weight flexibility without shipping multiple font files — better bundle, better hinting at each size.
- Tabular numerics are specifically useful on a dashboard where numbers change live (syncing progress, file counts). Without them, the layout wobbles and feels amateurish. This is a 4-character class-name add that punches well above its weight.

**Alternatives considered:**
- *Inter Variable.* Rejected: excellent font but not as signature of the target flavour as Geist.
- *System UI stack only (`font-family: -apple-system, BlinkMacSystemFont, ...`).* Rejected: ships with zero work but the UI reads as generic-OS rather than branded; users can't tell the three platforms apart visually and the Electron app should still feel intentional.

### Decision 10: Motion — CSS-only, bounded to named surfaces, respects `prefers-reduced-motion`

**Chosen:** No runtime motion library (no Framer Motion, no Motion One). Motion is delivered via Tailwind's built-in transition utilities and a small set of CSS `@keyframes` in `globals.css`. The permitted motion set is exhaustively:

| Surface | Animation | Duration | Easing |
|---------|-----------|----------|--------|
| Dialog content (open) | fade 0→1, scale 98%→100% | 150ms | cubic-bezier(0.16, 1, 0.3, 1) (ease-out-quint) |
| Dialog content (close) | fade 1→0, scale 100%→98% | 100ms | ease-in |
| Dialog overlay | fade 0→1 | 150ms | ease-out |
| DropdownMenu content | fade + 4px Y slide | 120ms | ease-out |
| Tooltip content | fade | 100ms | ease-out |
| Card border (hover) | `border-border` → `border-border/80` | 80ms | ease-out |
| Status badge dot — `syncing` | opacity pulse 0.5 ↔ 1.0 | 1.2s infinite | ease-in-out |
| Skeleton | horizontal shimmer | 1.5s infinite | linear |
| Toast (open/close) | fade + 4px Y slide | 150ms / 100ms | ease-out / ease-in |

All motion wraps inside `@media (prefers-reduced-motion: no-preference)` so that users with the OS reduced-motion preference see instant transitions (opacity switches at 0ms) with no shimmer, no pulse, no slide. The prefers-reduced-motion path is tested.

No other surfaces animate. The cards themselves do not fade-in on mount, do not reorder with animation, do not have hover-lift/scale effects. This is the "Linear/Vercel minimal motion" restraint: motion signals *state change*, never ambience.

**Rationale:**
- CSS-only is faithful to the target flavour. Linear and Vercel both ship primarily CSS-driven motion and the visual result is quieter than Framer Motion's default feel, which tends toward spring/bounce.
- Skipping a motion library saves ~30–50 KB from the renderer bundle, a category of weight we'd have to justify to add.
- The exhaustive surface table is a hard boundary. Future features must extend this table via spec delta — motion creep is a known UX smell and codifying the whitelist is cheaper than policing it.
- Radix primitives expose `data-state` attributes (open/closed) and the shadcn-generated components already include the Tailwind classes that respond to them; we piggyback on that rather than inventing a parallel animation layer.

**Alternatives considered:**
- *Framer Motion.* Rejected: weight and tone (spring defaults feel playful, not restrained). Also adds a React-internal context that interacts with RSC in ways we'd have to audit for the static export.
- *Ambient card hover-lift, animated list-item entry.* Rejected: violates the restraint. Ambient motion on a dashboard becomes annoying by week two; state-change motion remains useful indefinitely.
- *No motion at all.* Rejected: zero motion makes dialogs feel jarring (appearing in-place) and removes the pulse cue for "syncing" which is genuinely informative.

### Decision 11: Glass / depth on overlays only, never on base surfaces

**Chosen:** Apply `backdrop-blur-md` (Tailwind's 12px blur) plus a semi-transparent background (light theme: `bg-background/80`, dark theme: `bg-background/70`) to exactly two surfaces: the Dialog overlay/scrim and the DropdownMenu content panel. Additionally, the Tooltip uses `backdrop-blur-sm` for a subtler version of the same effect. Cards, dashboard toolbar, empty-state panel, and all always-visible chrome remain fully opaque.

**Rationale:**
- Glass-on-overlays is the Linear/Raycast idiom: it creates spatial hierarchy (overlay is above content) without making the base UI feel busy. Glass everywhere is the opposite — it's the early-2020s iOS-pastiche look that ages poorly.
- Chromium supports `backdrop-filter` robustly in the Electron versions we ship. No feature-detection or fallback branching needed.
- The opacity values are chosen so the base UI remains legible through the overlay (important when users are referencing the dashboard while a dialog is open) while still communicating "foreground/background" spatial depth.

**Alternatives considered:**
- *Glass on cards too.* Rejected: cards are background, not foreground; they'd read as distracting and compound against the dashboard's underlying treatment.
- *Hard opaque dialogs with a shadow, no blur.* Rejected: flatter than the target flavour. The blur is a cheap win for the "modern and elegant" intent.
- *Per-platform gate (blur only on macOS where it's native-feeling).* Rejected: Electron apps should feel consistent across OSes, not chase native parity.

### Decision 12: Empty-state uses a custom minimal SVG illustration, not stock iconography

**Chosen:** The empty dashboard renders a custom inline SVG under `apps/desktop/src/renderer/src/features/datasources/illustrations/empty-datasources.svg` — abstract, geometric, monochrome-plus-accent, using only CSS variable tokens for colour (so it theme-switches correctly). Subject matter is a stylised representation of a cloud / storage lattice; no faces, no mascots, no 3D, no dribbble-core vibes. Roughly 240×160px, positioned above the heading and CTA.

The illustration is fetched inline (no HTTP, no external request) and respects theme: strokes resolve to `hsl(var(--foreground))`, accent highlights to `hsl(var(--primary))`, both via CSS variables defined on the SVG root.

**Rationale:**
- A considered empty state is a high-leverage polish win. First-launch is the user's first impression; the default "no results" with a bullet point list is the opposite of elegant.
- Custom SVG beats stock icon packs because stock illustrations have a telltale generic-SaaS quality that works against the Linear/Vercel restraint.
- Monochrome + one accent keeps the illustration on-brand with the rest of the dashboard. Multi-colour illustrations fight the quiet tone.
- Inline SVG (not a file fetch) means no network, no flash, and the illustration inherits theme changes for free.

**Alternatives considered:**
- *Stock illustration pack (unDraw, Storyset, etc.).* Rejected: visual tone mismatch with Linear/Vercel and identifiable across many apps.
- *Heavy illustration (photorealistic, full-colour).* Rejected: fights the dense-quiet intent and feels marketing-page-ish, not product-chrome-ish.
- *Just a large `lucide-react` icon.* Rejected: the empty state is the one place to invest a small amount of bespoke visual effort; a 48px icon feels dismissive.

### Decision 13: Warm near-black dark theme (asymmetric palette, review-round-1)

**Chosen:** Keep the light theme on shadcn's `slate` base (cool neutrals, as per Decision 8). For the dark theme, override the neutral tokens with warm near-black values — `oklch` lightness in the `0.10`–`0.16` range, hue around `50` (warm/brown) with low chroma (`~0.010`). `--primary` accent stays unchanged across both themes so CTAs read identically. Only the `.dark` block in `globals.css` is rewritten; `:root` (light) is untouched.

Concrete token adjustments in the `.dark` block (other dark tokens follow the same warm-hue shift):

| Token | Original (slate-blue) | New (warm near-black) |
|-------|-----------------------|----------------------|
| `--background` | `oklch(0.129 0.042 264.695)` | `oklch(0.110 0.010 50)` |
| `--foreground` | `oklch(0.984 0.003 247.858)` | `oklch(0.950 0.006 50)` |
| `--card` | `oklch(0.208 0.042 265.755)` | `oklch(0.145 0.010 50)` |
| `--popover` | `oklch(0.208 0.042 265.755)` | `oklch(0.150 0.010 50)` |
| `--muted` | `oklch(0.279 0.041 260.031)` | `oklch(0.200 0.010 50)` |
| `--border` | `oklch(1 0 0 / 10%)` | `oklch(1 0 0 / 10%)` (unchanged) |

**Rationale:**
- User review of the live app (review-round-1) flagged the dark theme as reading "very dark blue" — a tone mismatch with the "timeless / considered" feel the Linear/Vercel flavour targets.
- Warm near-black neutrals are a well-known alternative reading in the dense-quiet family (compare Linear's default dark vs. Arc's warm dark vs. Notion's dark). It stays compatible with restraint; the hue shift is subtle enough that functional status colours (green/amber/red) remain readable.
- Keeping light on slate preserves existing visual coherence for contributors already familiar with the current light theme and avoids a second palette migration.
- `--primary` accent stays unchanged — primary CTAs must read identically across themes so users don't re-learn the accent color per mode.

**Alternatives considered:**
- *Symmetric palette (both themes warmed).* Rejected: user specified only the dark theme feels wrong; light on slate-cool is unchanged requirement. Symmetric would be unnecessary scope creep.
- *Switch shadcn base from `slate` to `stone` entirely.* Rejected: `stone` is warm but not near-black enough in its canonical dark values; the user asked for "very dark brown almost near black" which is warmer + darker than shadcn's stone defaults.

### Decision 14: App chrome — persistent header + footer around page content

**Chosen:** Wrap the renderer in a three-layer shell: `<AppHeader />` + `<main>` (page content) + `<AppFooter />`.

- **Header:** 48px tall, `border-b border-border`, full width. Left side: logo SVG + `FT5 Unified Cloud Sync` wordmark. Right side: `<ThemeSwitcher />` (moved from dashboard toolbar). The header is mounted once in `app/layout.tsx` and persists across any future routes.
- **Footer:** single line, `border-t border-border`, full width. Center-aligned: `© <currentYear> Forti5 Tech. All rights reserved.` `text-xs text-muted-foreground`. Year is `new Date().getFullYear()` so copyright notices don't rot.
- **Dashboard toolbar simplification:** with ThemeSwitcher lifted to the header, the dashboard's inner toolbar becomes just `Datasources` heading + `[+ Add datasource]` primary CTA. Cleaner separation between app-level chrome and page-level actions.

The window's existing `minWidth: 1024` (from Decision 8 risks) still holds; header + footer add ~88px of chrome but the card grid still has >80% of the vertical space.

**Rationale:**
- User review explicitly requested both header (with logo + product name) and footer (with copyright). The request is branding-first — the app should feel owned, not generic.
- Moving the ThemeSwitcher to the header separates "app settings" (theme) from "page actions" (add datasource). This is a cleaner mental model and matches Linear/Vercel conventions.
- `FT5 Unified Cloud Sync` is the **product name** used in the UI. The OS-level window title (`ft5-cloude-sync`) and installer name (`FT5 Cloude Sync`) are NOT changed in this decision — if the user wants those updated too, that's a separate change.

**Alternatives considered:**
- *Keep ThemeSwitcher in the dashboard toolbar, add header for branding only.* Rejected: redundant chrome density; two toolbars competing for the user's eye.
- *Put theme + add-datasource both in the header.* Rejected: app-wide controls and page-specific actions don't belong at the same level. Add Datasource is page-scoped.

### Decision 15: Primary-action glyphs — icon + label for every primary CTA

**Chosen:** Every primary call-to-action button renders a `lucide-react` icon before its label, at 16px, with `mr-1.5` gap. Applies to: "Add datasource" (`plus`), quick-action menu items (Sync now → `refresh-cw`, Pause → `pause`, Resume → `play`, Upload from local → `upload`, Settings → `settings`, Remove → `trash-2`). Icons go through the `Icon` adapter (Decision 4 for the theme switcher extended for these names).

The `IconName` type union expands to include: `"plus" | "refresh-cw" | "pause" | "play" | "upload" | "settings" | "trash-2"` on top of the existing provider/theme names.

**Rationale:**
- User review found text-only primary CTAs "needed a convincing glyph." Icon + label increases scannability and matches the Linear/Vercel convention of iconic primary buttons.
- Doing this for every primary surface (toolbar CTA + all quick-action menu items) keeps the convention consistent; mixed iconic/non-iconic CTAs would feel inconsistent.
- Icons are semantic (`plus` for add, `trash-2` for remove) — they're redundant-with-label, not replacing-label. A11y unchanged (labels still read by screen readers; icons `aria-hidden`).

**Alternatives considered:**
- *Icon-only buttons (no label).* Rejected: hurts discoverability. Labels stay.
- *Icon-on-hover reveals.* Rejected: adds motion to a surface we're keeping quiet. Icons ship statically.

### Decision 16: Ambient geometric watermark on the dashboard canvas

**Chosen:** A single SVG tile pattern applied as `background-image` on the `<main>` surface of the dashboard (NOT on the header, NOT on the footer, NOT on cards). The pattern is a faint geometric lattice — a rotated grid of small dots or a diamond weave, ~24px tile size — rendered at `opacity: 0.08–0.10` (subtle-visible per user review-round-1, Q2=B).

Implementation: SVG pattern defined inline as a data URL in `globals.css`, referenced via a custom CSS variable (`--watermark-image`) so it can be theme-aware (different stroke colour per theme via `currentColor` resolution, or separate light/dark SVG URLs if `currentColor` doesn't cascade through `background-image`).

The watermark is static. It does NOT animate, scroll-parallax, or respond to pointer — that would violate Decision 10's motion budget.

**Rationale:**
- User review asked for "some sort of texture or watermark spread across the background … something like geometric symmetry" and specified "subtle but visible (≈8–12% opacity, branded but quiet)."
- At the chosen opacity, the watermark is *felt, not seen*: users notice the surface has presence without the pattern drawing attention. This matches Linear's faint-grid-in-empty-states convention and Raycast's subtle-noise canvas.
- Confining the watermark to the dashboard's main surface keeps the app header/footer and cards clean — the pattern is a canvas accent, not everywhere decoration.

**Alternatives considered:**
- *Visible-but-branded logo watermark (opacity 0.15+).* Rejected: crosses from "felt" into "decoration," fights Decision 8's quiet tone.
- *Skip the watermark.* Rejected: user explicitly requested it, and it's a cheap way to make the dashboard feel considered instead of default-Tailwind.
- *Animate the watermark (subtle drift).* Rejected: violates Decision 10's motion budget whitelist.

## Visual direction

_Approved 2026-04-19 (review-round-1). This section is the source of truth consulted during implementation. Any deviation requires going back to brainstorming, not forward — per CLAUDE.md "UI/UX work" section._

- **Aesthetic:** Linear/Vercel dense-quiet, refined with a warm near-black dark theme and a subtle ambient watermark. Dense by default (high info yield), quiet by discipline (no ambient motion, glass only on overlays).
- **Typography:** Geist Sans (UI) + Geist Mono (code/monospace). Body `text-sm` (14px), section headings `text-base`/`text-lg`. `tabular-nums` on every numeric dashboard field.
- **Palette — light theme:** shadcn "new-york" + "slate" base. Cool neutrals, slate blacks. Single `--primary` accent for CTAs and sync-active indicators.
- **Palette — dark theme:** **asymmetric** from light — warm near-black neutrals (oklch lightness 0.10–0.16, hue ~50 warm, low chroma). `--primary` unchanged from light. See Decision 13 for exact token values.
- **Spacing:** `p-4` cards, `gap-3` dashboard grid, 48px chrome bars (header + toolbar). Radii ceiling `rounded-md` (6px) except Dialog content (`rounded-lg`, 8px).
- **Motion budget:** CSS-only, exhaustive whitelist (Decision 10): dialog/menu/tooltip open-close, sync-pulse, skeleton-shimmer, hover borders. `prefers-reduced-motion` respected globally.
- **Depth:** base surfaces flat. Hairline borders for separation. Glass (`backdrop-blur-md`/`backdrop-blur-sm`) only on Dialog / DropdownMenu / Tooltip overlays.
- **App chrome:** persistent header with logo + `FT5 Unified Cloud Sync` wordmark + ThemeSwitcher. Persistent footer with `© <year> Forti5 Tech. All rights reserved.` Page content sits between.
- **Iconography:** `lucide-react` via the `Icon` adapter. Every primary CTA is icon+label. 16px icons in card bodies and CTAs; 18px in chrome.
- **Ambient layer:** a single geometric SVG tile pattern at ~10% opacity across the dashboard canvas (not chrome, not cards). Theme-aware. Static.
- **Status colour language:** green (connected), amber (syncing), zinc (paused), red (error). Only used in status pills + error surfaces, never as large-area fills.
- **Accessibility:** WCAG 2.2 non-text contrast on focus rings and interactive states. Keyboard-first: every action reachable without a pointer. Icon+label (not icon-only) on all primary CTAs.

## Risks / Trade-offs

- **Tailwind's build output scales with class usage.** For an Electron app the bundle-size pressure is low, but we should keep an eye on the renderer's exported CSS size (target: <80 KB gzipped) as primitives grow. If it balloons, we move to Tailwind's JIT purge mode (default in v4 anyway) or per-component CSS.
- **Mocked OAuth is a credibility risk in demos.** Anyone showing the app to a stakeholder and clicking "Connect Google Drive" will see a success after 1 second with no real auth. The add-dialog must clearly label the provider step as "Mocked connection — real OAuth arrives in a follow-up change" until real OAuth lands. Not a user-facing footgun because there are no users yet; a demoer-facing footgun we mitigate with copy.
- **Card layout on narrow widths.** The card has a lot of surface: name, provider icon, status badge, usage bar, last-sync line, item counts, up to five quick actions. The main window's minimum width needs to be wide enough that the card doesn't wrap ugly. We set `minWidth: 1024` on the `BrowserWindow` and enforce a responsive collapse (hides optional fields, folds actions into an overflow menu) below that.
- **State migration when real providers land.** The mocked `DatasourceSummary` shape is likely close-to-correct but not identical to what real providers yield. We'll capture the delta in the follow-up change's migration section and treat any UI-visible change as a spec update, not a silent contract drift.
- **Tension between "Linear/Vercel minimal motion" and the motion upgrade.** The user picked the restrained flavour AND asked for motion upgrades. These are compatible if and only if motion is strictly state-change-only (Decision 10's exhaustive table) and never ambient. Motion creep — "just one more subtle animation" added ad-hoc — is how this intent gets undermined. The exhaustive table plus the `prefers-reduced-motion` gate plus spec-delta discipline for future motion additions are the mitigation.
- **Bundle impact of Geist font.** Geist Sans variable is ~60 KB woff2, Geist Mono ~55 KB. ~115 KB of font weight loaded as a resource-blocking asset. Acceptable for a desktop app (no network), and `next/font` preloads correctly without layout shift, but worth naming. If we find bundle pressure later, subset Geist to Latin-only (halves the weight).

## Migration Plan

- Existing ping page moves to `/diagnostics`. Existing Playwright e2e (`apps/desktop/e2e/ping.spec.ts`) updates its navigation step to visit `app://./diagnostics` instead of the home route. This is the only test that needs a path change.
- Existing renderer CSS (there is none) and layout are replaced. No data migration (no persisted data yet).
- No breaking changes to `packages/ipc-contracts/` — only additions (`datasources.ts` alongside the existing `ping` types).

## Open Questions

- Should the dashboard be the only home view long-term, or will we introduce a left-nav for Settings / Activity / Diagnostics when those land? Leaving open; for now the dashboard is single-pane. Left-nav is a cheap retrofit inside the existing layout shell.
- Do we want a "favourite" / "starred" concept on datasources (pin to top)? Deferred until we have enough datasources on screen to want it.
- Where do per-datasource sync rules live in the UI (inline on the card, in a settings drawer, in a separate route)? Deferred to the sync-rules change. This design leaves a `settings` quick action stubbed out so the entry point exists.
