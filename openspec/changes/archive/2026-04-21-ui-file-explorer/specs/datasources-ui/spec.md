# datasources-ui

## MODIFIED Requirements

### Requirement: Datasource card surfaces the standardized summary fields

Every `DatasourceCard` SHALL render the following fields from its `DatasourceSummary`: provider icon, datasource display name, connection status badge, last-sync timestamp (or "never" if null), item count, and a quick-actions control surface. The card SHALL additionally render a storage usage bar with used/quota labels IF AND ONLY IF `provider.capabilities.quota === true` for the card's provider descriptor.

Connection status SHALL be one of exactly `connected`, `syncing`, `paused`, `error`. The badge's accessible name SHALL include the status word; colour alone SHALL NOT be the only status signal.

#### Scenario: Card renders all required fields

- **WHEN** a `DatasourceCard` is rendered against a non-null `DatasourceSummary`
- **THEN** the card contains a provider icon, the display name as its accessible heading, a status badge whose accessible name includes the status word, a last-sync text (timestamp or "never"), an item count, and a quick-actions trigger — every element is queryable by role and accessible name

#### Scenario: S3 card omits the usage bar

- **WHEN** a `DatasourceCard` is rendered for a datasource whose provider descriptor has `capabilities.quota === false`
- **THEN** no usage bar, no used/quota text, and no quota-related ARIA label is rendered

#### Scenario: Quick-action menu exposes explore, sync-now, pause, upload, settings, remove

- **WHEN** the user opens the card's quick-actions control (click, Enter, or Space on the trigger)
- **THEN** a menu opens with these items in this order: "Explore", "Sync now", "Pause" / "Resume" (label depends on current status), "Upload from local…", "Settings", "Remove". Each item is keyboard-reachable, has an accessible name, and closing the menu restores focus to the trigger

#### Scenario: Explore quick-action navigates to the file explorer for this datasource

- **WHEN** the user activates the "Explore" item on the quick-actions menu of the card whose datasource id is `<id>`
- **THEN** the renderer navigates to `/datasources/explore?id=<id>`; the dashboard is replaced by the file-explorer view; no IPC call on the datasources surface is issued as part of this navigation (the explorer fetches its own data via the files IPC surface after it mounts)

#### Scenario: Error status exposes the error reason

- **WHEN** a `DatasourceCard` renders a summary with `status === "error"`
- **THEN** the card renders the `errorReason` string from the summary as readable text, and the status badge's accessible name includes both "error" and the reason
