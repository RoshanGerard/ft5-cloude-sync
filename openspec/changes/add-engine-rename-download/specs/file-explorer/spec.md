# file-explorer — Delta for `add-engine-rename-download`

## REMOVED Requirements

### Requirement: Rename and Download affordances are disabled for engine-backed datasources

**Reason:** This change wires `files:rename` and `files:download` through
the live engine + fs-sync service. With the engine pathway in place, the
disabled-affordance scenario no longer applies — Rename and Download are
available on engine-backed datasources.

**Migration:** Replaced by the new requirement "Rename and Download
affordances are enabled with provider-conditional folder rename" below.
The renderer's `isEngineBacked` gate in `context-menu.tsx` is removed (or
inverted into a narrower `directoryRenameDisabledForProvider(providerKind)`
check that covers only S3 directories — the engine's strategy resolves
kind itself, but the renderer still uses the entry's `kind` field plus
`providerKind` to decide whether to render the affordance disabled). The `aria-disabled` assertions on Rename / Download in the
existing renderer tests are flipped to assertions that the items are
enabled and dispatch the new IPC commands.

## ADDED Requirements

### Requirement: Rename and Download affordances are enabled with provider-conditional folder rename

The file-explorer's Rename and Download affordances SHALL be enabled for
every engine-backed datasource. The exception is folder rename on Amazon
S3, which SHALL render disabled with a provider-specific tooltip. The
specific behaviors:

- **Rename file**: enabled on every provider (Drive, OneDrive, S3, mock).
  Activation begins the inline-rename flow via the existing
  `entry-name-cell.tsx` `editingId` mechanism. On commit, the renderer
  store dispatches `window.api.files.rename({ datasourceId, path,
  handle, newName, conflictPolicy: "fail" })`. On a `tag: "conflict"`
  response, the existing `ConflictResolutionDialog` re-prompts and
  re-dispatches with the user's chosen policy.

- **Rename directory** on Drive / OneDrive: enabled. Same wire shape
  as rename file — the IPC carries no `kind` field; the engine's
  strategy determines kind within its own provider context.

- **Rename directory** on S3: SHALL render disabled with
  `aria-disabled="true"` and tooltip "Folder rename isn't supported on S3"
  (no change-id reference; a follow-up change is not yet named).
  Activation SHALL be a no-op.

- **Rename directory** on synthetic mock datasources: SHALL render
  disabled with the existing tooltip "Folder rename is not supported in
  this version" (this preserves the prior mock behavior for the "no
  folder rename in v1" mock policy).

- **Download** on every provider for files: enabled. Activation
  triggers the renderer's download orchestrator which resolves the
  per-download `toPath` from user preferences (default folder, always-ask
  toggle, Shift+Click modifier per the renderer-side store described in
  the "Downloads preferences" requirement below) and dispatches
  `window.api.files.download({ datasourceId, path, handle, toPath })`.

- **Download** on directories: SHALL remain disabled (folder download
  is out of scope for this change). Tooltip "Folder download is not
  supported in this version".

#### Scenario: Rename file on a Google Drive datasource

- **WHEN** the user right-clicks a file entry from a Google Drive datasource and selects Rename, types "renamed.pdf", and presses Enter
- **THEN** the inline rename input commits, the store dispatches `window.api.files.rename({ datasourceId, path: "/foo.pdf", newName: "renamed.pdf", conflictPolicy: "fail" })`, the response carries the renamed entry, and the row reflects the new name without a manual refresh

#### Scenario: Rename directory on Drive

- **WHEN** the user renames a folder on a Google Drive datasource
- **THEN** the inline rename flow dispatches `files.rename({ datasourceId, path, handle, newName, conflictPolicy: "fail" })`; the engine's Drive strategy identifies the target as a folder via its metadata and proceeds with the same `files.update` call as for files; the entry's name updates on success

#### Scenario: Rename directory on S3 is disabled with provider-specific tooltip

- **WHEN** the user right-clicks a folder entry on an Amazon S3 datasource and the context menu opens
- **THEN** the "Rename" item has `aria-disabled="true"`, is keyboard-focusable, and its tooltip reads "Folder rename isn't supported on S3"; activating it (click or Enter) is a no-op

#### Scenario: Download a file from S3

- **WHEN** the user clicks Download on a file entry from an Amazon S3 datasource (with the default folder set, no Shift modifier, "Always ask" toggle off)
- **THEN** the download orchestrator computes `toPath` as `<defaultFolder>/<fileName>`, dispatches `window.api.files.download({ datasourceId, path, toPath })`, opens a Sonner toast bound to the returned `transactionId`, subscribes to the progress feed; on completion the toast flips to the success variant with `[Show in folder]` and `[Open]` actions

#### Scenario: Rename conflict re-prompts via ConflictResolutionDialog

- **WHEN** the user renames `foo.pdf` to `bar.pdf` and `bar.pdf` already exists at the same parent path (the IPC response is `{ ok: false, error: { tag: "conflict", existingPath: "/parent/bar.pdf" } }`)
- **THEN** the existing `ConflictResolutionDialog` opens with the colliding path; the user picks "Overwrite", the renderer re-dispatches with `conflictPolicy: "overwrite"`, the IPC succeeds, and the row updates to the new name

### Requirement: Download success toast presents Open and Show-in-folder actions

A successful download SHALL surface a Sonner toast with the file name,
a primary CTA "Open" (filled blue button), and a secondary text link
"Show in folder". The toast SHALL auto-dismiss after the same timer used
by the upload-success toast. Activating "Open" SHALL invoke
`shell.openPath(savedPath)` via a new preload exposure
`window.api.files.openSavedPath(savedPath)`. Activating "Show in folder"
SHALL invoke `shell.showItemInFolder(savedPath)` via
`window.api.files.showSavedInFolder(savedPath)`.

The toast SHALL be a Sonner `toast.custom()` rendering with the layout:

```
┌───────────────────────────────────────────────────┐
│ ✓ Downloaded <fileName>                           │
│                                                   │
│         Show in folder         [    Open    ]     │
└───────────────────────────────────────────────────┘
```

In-flight: a Sonner toast SHALL display "Downloading <fileName>" with a
progress bar and an X to cancel. On `download-failed`: the toast SHALL
flip to red (using Sonner's per-toast `richColors: true` override) with
"Download failed: <message>" and a Retry action button that re-dispatches
the original request from byte 0. On `download-cancelled`: the toast
SHALL be dismissed silently.

#### Scenario: Successful download surfaces Open + Show in folder

- **WHEN** a download completes (the IPC reply is `{ ok: true, value: { savedPath: "/Users/alice/Downloads/ft5/welcome.pdf", bytes: 12345 } }`)
- **THEN** the in-flight toast updates to the success variant with the file name "welcome.pdf", a quieter "Show in folder" link, and a primary "Open" button; the toast auto-dismisses after the upload-toast success duration

#### Scenario: Open invokes shell.openPath

- **WHEN** the user clicks "Open" on the success toast
- **THEN** the renderer calls `window.api.files.openSavedPath("/Users/alice/Downloads/ft5/welcome.pdf")`; the preload routes to a main-process IPC that invokes `shell.openPath(savedPath)`; the toast dismisses

#### Scenario: Show in folder invokes shell.showItemInFolder

- **WHEN** the user clicks "Show in folder"
- **THEN** the renderer calls `window.api.files.showSavedInFolder(savedPath)`; the main-process IPC invokes `shell.showItemInFolder(savedPath)`; the toast dismisses

#### Scenario: Download failure shows Retry

- **WHEN** a download fails (IPC reply `{ ok: false, error: { tag: "auth-revoked" | "other" | …, message } }`)
- **THEN** the toast flips to red with copy "Download failed: <message>"; a Retry action button is present; activating Retry re-dispatches `window.api.files.download` with the original parameters and opens a new toast bound to the new transactionId

### Requirement: First-run downloads modal collects the default folder

The renderer SHALL render a blocking modal on the user's first-ever
download attempt (detected by absence of the `ft5.downloads.defaultFolder`
key in the renderer's preferences store). The modal SHALL:

- Render via the shadcn `Dialog` primitive (modal, focus-trapped,
  Escape-disabled — the user must commit a folder).
- Display title "Where should downloads go?" and body "Choose a default
  folder. You can change this later in Settings or use 'Save as…' to
  pick per file."
- Pre-fill the path input with the OS default downloads folder
  (`app.getPath("downloads")` joined with `"ft5"`, e.g.
  `~/Downloads/ft5` on Unix).
- Provide a "Browse…" button that opens
  `dialog.showOpenDialog({ properties: ['openDirectory',
  'createDirectory'] })` and updates the path input on selection.
- Provide a single primary CTA "Use this folder" which persists the
  chosen folder via `window.api.preferences.setDefaultDownloadsFolder(folder)`
  (the preload exposes a thin shim around the localStorage write so the
  main process can persist via its own mechanism if v2 evolves the
  storage layer; v1 is renderer-only).
- Provide NO Skip / Close affordance. The modal closes only when the
  user confirms.

After the modal closes, the deferred download dispatches automatically
to the now-set default folder.

#### Scenario: First-ever download triggers the modal

- **WHEN** the user clicks Download on a file entry, the localStorage key `ft5.downloads.defaultFolder` is absent
- **THEN** the file-explorer renders `<FirstDownloadModal>` with the OS default downloads folder pre-filled; no IPC dispatch occurs yet

#### Scenario: Modal commit persists default and dispatches the deferred download

- **WHEN** the user accepts the pre-filled `~/Downloads/ft5` and clicks "Use this folder"
- **THEN** the localStorage key `ft5.downloads.defaultFolder` is set to the chosen path; the modal closes; the originally-clicked download is dispatched against that path; a Sonner toast opens for the in-flight download

#### Scenario: Modal cannot be dismissed without commit

- **WHEN** the modal is open and the user presses Escape or clicks the backdrop
- **THEN** the modal does not close; the focus remains trapped inside; the deferred download remains queued

### Requirement: Settings dialog includes a Downloads section

The `SettingsDialog` SHALL gain a "DOWNLOADS" section containing two rows. The existing dialog currently contains only the Motion section; the new section sits as a sibling. The two rows are:

- **Default folder**: label, current path display (truncated with
  ellipsis on long paths), Open button, Change… button. Open invokes
  `shell.showItemInFolder(folder)` via a new preload exposure. Change…
  opens `dialog.showOpenDialog({ properties: ['openDirectory',
  'createDirectory'] })` and updates the stored value on selection.

- **Always ask where to save**: label "Always ask where to save", body
  "Show the Save-as dialog for every download.", a Switch (the same
  shadcn `Switch` primitive used by the Motion row).

The section SHALL be implemented as a sibling of the existing Motion
section in `settings-dialog.tsx`, using the same heading-and-row
typography. The section SHALL be reachable via Tab from the Motion
row's Switch and SHALL trap focus consistently with the existing
modal behavior.

#### Scenario: Default folder display matches stored preference

- **WHEN** the user opens Settings and the localStorage key `ft5.downloads.defaultFolder` is set to `/Users/alice/Downloads/ft5`
- **THEN** the Default folder row displays `/Users/alice/Downloads/ft5` (truncated if long), an Open button, and a Change… button

#### Scenario: Change… updates the default folder

- **WHEN** the user clicks Change…, picks `/Users/alice/cloud-files` from the OS picker, and confirms
- **THEN** the localStorage key updates to `/Users/alice/cloud-files`; the row's path display updates immediately; subsequent downloads (with no Shift modifier and Always-ask off) target the new folder

#### Scenario: Always-ask toggle enables per-download save dialog

- **WHEN** the user toggles "Always ask where to save" to on
- **THEN** the localStorage key `ft5.downloads.alwaysAsk` is set to `"yes"`; the next Download click triggers `dialog.showSaveDialog` for the per-download path; the default folder is the dialog's starting location

### Requirement: Downloads preferences resolve `toPath` from store + modifier keys

The renderer SHALL maintain a `downloads-store` at
`apps/desktop/src/renderer/src/features/settings/downloads-store.ts`
modeled on the existing `motion-store.ts` pattern: `useSyncExternalStore`
hook, `localStorage` persistence, no main-process write-through. Stored
keys:

- `ft5.downloads.defaultFolder`: absolute folder path string. Absent
  if not yet set; first download triggers the modal that sets it.
- `ft5.downloads.alwaysAsk`: `"yes"` (toggle on) or absent (toggle off).
  No `"no"` representation; key absence is the default.

The download orchestrator SHALL compute `toPath` for each download as:

1. If the click event carries `shiftKey: true` OR `alwaysAsk === "yes"`,
   open `dialog.showSaveDialog` (default value
   `<defaultFolder>/<fileName>`) and use the returned path. If the user
   cancels the save dialog, the download is NOT dispatched.
2. Otherwise, set `toPath = <defaultFolder>/<fileName>`. If the local
   file already exists at that path, the OS-level overwrite handling
   is delegated to `dialog.showSaveDialog` only when triggered (i.e.,
   step 1). Step 2 silently overwrites — matching browser-default
   behavior for "auto-save to folder" downloads.

#### Scenario: Default folder path resolution

- **WHEN** the default folder is `/Users/alice/Downloads/ft5`, Always-ask is off, no Shift modifier, and the user downloads `welcome.pdf`
- **THEN** `toPath` is computed as `/Users/alice/Downloads/ft5/welcome.pdf`; the download dispatches against that path

#### Scenario: Shift+Click forces Save-as

- **WHEN** the user Shift+Clicks Download on `welcome.pdf` (default folder is set, Always-ask is off)
- **THEN** `dialog.showSaveDialog` opens with default value `<defaultFolder>/welcome.pdf`; if the user picks `/tmp/welcome.pdf`, the download dispatches against that path; if the user cancels, no IPC dispatch occurs

#### Scenario: Always-ask routing

- **WHEN** Always-ask is on and the user clicks Download (no Shift)
- **THEN** the orchestrator behaves as if Shift+Click had occurred: `dialog.showSaveDialog` opens; on confirm, the download dispatches; on cancel, no dispatch

### Requirement: App-launch hydrates active downloads from the service registry

The desktop main process SHALL invoke `sync.request("downloads:list-active")` exactly once on the supervisor's first successful connect of an app session and forward the response to the renderer via a new event channel `window.api.files.onActiveDownloadsHydrate(callback)`. The renderer's
file-explorer init effect SHALL subscribe to this channel and, on
receipt, spawn one Sonner toast per `DownloadJob` in the snapshot, each
bound to its `transactionId`'s progress feed.

The hydration SHALL fire exactly once per app session — on the first
supervisor connect of the renderer's lifetime, NOT on every reconnect.
A reconnect during the session does NOT re-hydrate; instead the existing
event subscriptions resume.

#### Scenario: App reopen with one active download

- **WHEN** the user closes the app while a download is in flight (service keeps running, registry has one entry); the user reopens the app; the supervisor establishes its first connect
- **THEN** the desktop main process queries `downloads:list-active` exactly once; the response carries one `DownloadJob`; the renderer's file-explorer init effect spawns one Sonner toast at the current progress percentage and subscribes to the `transactionId`'s feed; subsequent `downloading` events update the toast in place; on terminal completion the toast flips to the success variant

#### Scenario: App reopen with no active downloads

- **WHEN** the user reopens the app and the service's registry is empty
- **THEN** the hydrate response carries `jobs: []`; no toasts are spawned; the file-explorer renders normally

#### Scenario: Mid-session reconnect does NOT re-hydrate

- **WHEN** the supervisor reconnects mid-session (e.g., after a transient pipe disconnect) and downloads are in flight
- **THEN** the renderer does NOT re-spawn toasts; existing toasts and event subscriptions resume; the registry query is NOT re-issued
