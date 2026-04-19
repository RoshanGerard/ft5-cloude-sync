/** @vitest-environment jsdom */
//
// Phase 9.3 — Structural WCAG 2.2 AA sanity checks for the datasources UI.
//
// Decision (from the task brief): we do NOT add `@axe-core/react` or
// `jest-axe` as a new dependency. Instead, we assert the role/name/label
// structure directly — enough to catch regressions in DOM semantics (missing
// headings, unlabeled status badges, unnamed menu triggers, dialog without
// aria-labelledby, inputs without associated <Label>) without pulling in an
// extra ~2 MB of testing infrastructure.
//
// Covers:
//   - Dashboard populated state:
//       • exactly one <h1> (the "Datasources" page title in the toolbar)
//       • every DatasourceCard root contains a heading
//       • status badges have accessible names starting with "Status:"
//       • quick-actions menu trigger has accessible name "Quick actions"
//   - Dashboard empty state:
//       • CTA accessible name matches /add datasource/i
//   - Dashboard error state:
//       • error container has role="alert"
//
// The add-dialog a11y subgroup lives in `add-dialog.test.tsx` already (task
// 6.1 covers dialog role and title wiring); we extend *this* file with a few
// additional structural assertions for dialog aria-labelledby pairing, Label
// ↔ Input htmlFor pairing, and keyboard focusability of Back/Close/Connect.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { DatasourceSummary } from "@ft5/ipc-contracts";

import { DatasourcesProvider } from "../store";
import { DatasourcesDashboard } from "../dashboard";

// --- API mocks ---

let listMock: Mock;
let addMock: Mock;
let removeMock: Mock;
let actionMock: Mock;
let uploadMock: Mock;

function installApiMock() {
  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: listMock,
      add: addMock,
      remove: removeMock,
      action: actionMock,
      upload: uploadMock,
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
    },
  };
}

// A fixture with one of each status so StatusBadge a11y names can be
// exercised across the set.
const POPULATED_FIXTURE: DatasourceSummary[] = [
  {
    id: "ds-1",
    displayName: "Personal Drive",
    providerId: "google-drive",
    status: "connected",
    lastSyncAt: 1_700_000_000_000,
    itemCount: 1240,
    usage: { used: 12_000_000_000, quota: 16_000_000_000 },
  },
  {
    id: "ds-2",
    displayName: "Team OneDrive",
    providerId: "onedrive",
    status: "syncing",
    lastSyncAt: 1_700_000_100_000,
    itemCount: 512,
    usage: { used: 800_000_000, quota: 1_000_000_000 },
  },
  {
    id: "ds-3",
    displayName: "Archive Bucket",
    providerId: "amazon-s3",
    status: "paused",
    lastSyncAt: null,
    itemCount: 23,
  },
  {
    id: "ds-4",
    displayName: "Broken Drive",
    providerId: "google-drive",
    status: "error",
    lastSyncAt: null,
    itemCount: 0,
    errorReason: "Token expired",
  },
];

beforeEach(() => {
  // Radix DropdownMenu + Dialog rely on ResizeObserver at mount, which jsdom
  // does not implement. Polyfill as a no-op class.
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
  listMock = vi.fn();
  addMock = vi.fn();
  removeMock = vi.fn();
  actionMock = vi.fn();
  uploadMock = vi.fn();
  installApiMock();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Dashboard a11y — populated state (task 9.3)", () => {
  it("renders exactly one <h1> (the page title)", async () => {
    listMock.mockResolvedValue({ datasources: POPULATED_FIXTURE });
    render(
      <DatasourcesProvider>
        <DatasourcesDashboard />
      </DatasourcesProvider>,
    );
    // Wait for population.
    await screen.findByTestId("datasources-grid");

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe("Datasources");
  });

  it("every DatasourceCard contains a heading", async () => {
    listMock.mockResolvedValue({ datasources: POPULATED_FIXTURE });
    render(
      <DatasourcesProvider>
        <DatasourcesDashboard />
      </DatasourcesProvider>,
    );

    await waitFor(() => {
      const cards = document.querySelectorAll<HTMLElement>(
        "[data-testid='datasource-card']",
      );
      expect(cards.length).toBe(POPULATED_FIXTURE.length);
    });

    const cards = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-testid='datasource-card']",
      ),
    );
    for (const card of cards) {
      const heading = within(card).queryByRole("heading");
      expect(
        heading,
        `expected a heading inside every datasource card; missing on ${card.getAttribute("data-datasource-id")}`,
      ).not.toBeNull();
    }
  });

  it("every status badge has an accessible name starting with 'Status:'", async () => {
    listMock.mockResolvedValue({ datasources: POPULATED_FIXTURE });
    render(
      <DatasourcesProvider>
        <DatasourcesDashboard />
      </DatasourcesProvider>,
    );

    await screen.findByTestId("datasources-grid");

    const badges = Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-testid='datasource-status']",
      ),
    );
    expect(badges.length).toBe(POPULATED_FIXTURE.length);
    for (const badge of badges) {
      const label = badge.getAttribute("aria-label");
      expect(label, `expected aria-label on status badge`).not.toBeNull();
      expect(label!.startsWith("Status:")).toBe(true);
    }
  });

  it("every quick-actions menu trigger has accessible name 'Quick actions'", async () => {
    listMock.mockResolvedValue({ datasources: POPULATED_FIXTURE });
    render(
      <DatasourcesProvider>
        <DatasourcesDashboard />
      </DatasourcesProvider>,
    );
    await screen.findByTestId("datasources-grid");

    // Each card owns one trigger — `getAllByRole` with the name filter
    // validates both presence and accessible name in a single pass.
    const triggers = screen.getAllByRole("button", { name: /quick actions/i });
    expect(triggers.length).toBe(POPULATED_FIXTURE.length);
  });

  it("error-status card surfaces the reason via the badge's accessible name", async () => {
    listMock.mockResolvedValue({
      datasources: [POPULATED_FIXTURE[3]!], // the error one
    });
    render(
      <DatasourcesProvider>
        <DatasourcesDashboard />
      </DatasourcesProvider>,
    );
    await screen.findByTestId("datasources-grid");

    const badge = document.querySelector<HTMLElement>(
      "[data-testid='datasource-status']",
    );
    expect(badge).not.toBeNull();
    const label = badge!.getAttribute("aria-label");
    expect(label).toMatch(/^Status: error/);
    // The reason is part of the accessible name.
    expect(label).toContain("Token expired");
  });
});

describe("Dashboard a11y — empty state (task 9.3)", () => {
  it("empty-state CTA has accessible name matching /add datasource/i", async () => {
    listMock.mockResolvedValue({ datasources: [] });
    render(
      <DatasourcesProvider>
        <DatasourcesDashboard />
      </DatasourcesProvider>,
    );

    const emptyPanel = await screen.findByTestId("datasources-empty");
    const cta = within(emptyPanel).getByRole("button", {
      name: /add datasource/i,
    });
    expect(cta).toBeInTheDocument();
    // Keyboard focusability — no explicit tabindex override should be needed.
    cta.focus();
    expect(cta).toHaveFocus();
  });
});

describe("Dashboard a11y — error state (task 9.3)", () => {
  it("error panel renders role='alert'", async () => {
    listMock.mockRejectedValue(new Error("Network is down"));
    render(
      <DatasourcesProvider>
        <DatasourcesDashboard />
      </DatasourcesProvider>,
    );

    // The error panel surfaces via findByRole('alert').
    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toMatch(/network is down/i);
  });
});

// --- Add-dialog a11y structural subgroup (extends add-dialog.test.tsx) ---

describe("AddDatasourceDialog a11y — structural (task 9.3)", () => {
  it("dialog has role='dialog' and aria-labelledby pointing at DialogTitle", async () => {
    listMock.mockResolvedValue({ datasources: [] });
    render(
      <DatasourcesProvider>
        <DatasourcesDashboard />
      </DatasourcesProvider>,
    );

    await screen.findByTestId("datasources-empty");
    fireEvent.click(screen.getByTestId("add-datasource-trigger"));

    const dialog = await screen.findByRole("dialog");
    const labelledby = dialog.getAttribute("aria-labelledby");
    expect(
      labelledby,
      "dialog must carry aria-labelledby for the WCAG name",
    ).not.toBeNull();
    // The referenced id must resolve to a node with the expected title text.
    // We avoid asserting a specific id value because Radix generates them.
    const title = document.getElementById(labelledby!);
    expect(title, `aria-labelledby="${labelledby}" must resolve`).not.toBeNull();
    expect(title!.textContent).toMatch(/add datasource/i);
  });

  it("every credential-form input has an associated <Label> (htmlFor pair)", async () => {
    listMock.mockResolvedValue({ datasources: [] });
    render(
      <DatasourcesProvider>
        <DatasourcesDashboard />
      </DatasourcesProvider>,
    );

    await screen.findByTestId("datasources-empty");
    fireEvent.click(screen.getByTestId("add-datasource-trigger"));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByTestId("provider-option-amazon-s3"),
    );

    // All four AWS credential fields must each have an associated label.
    // `getByLabelText` specifically requires the label-input pair (htmlFor
    // + id) to resolve, so a failure here means the form shipped without
    // proper labeling.
    const accessKey = await within(dialog).findByLabelText(/access key id/i);
    const secret = within(dialog).getByLabelText(/secret access key/i);
    const region = within(dialog).getByLabelText(/region/i);
    const bucket = within(dialog).getByLabelText(/bucket/i);

    for (const input of [accessKey, secret, region, bucket]) {
      // Inputs must be discoverable by name — i.e. must render with a non-
      // empty `id` attribute that the Label's htmlFor can point at.
      expect(input).toBeInstanceOf(HTMLInputElement);
      expect(input.getAttribute("id")).toBeTruthy();
    }
  });

  it("Back, Connect, and Close controls in AWS step are keyboard-focusable", async () => {
    listMock.mockResolvedValue({ datasources: [] });
    render(
      <DatasourcesProvider>
        <DatasourcesDashboard />
      </DatasourcesProvider>,
    );

    await screen.findByTestId("datasources-empty");
    fireEvent.click(screen.getByTestId("add-datasource-trigger"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      within(dialog).getByTestId("provider-option-amazon-s3"),
    );

    // Fill fields so the Connect button is enabled.
    const accessKey = await within(dialog).findByLabelText(/access key id/i);
    fireEvent.change(accessKey, { target: { value: "AKIAEXAMPLE" } });
    fireEvent.change(within(dialog).getByLabelText(/secret access key/i), {
      target: { value: "s3cret" },
    });
    fireEvent.change(within(dialog).getByLabelText(/bucket/i), {
      target: { value: "backup" },
    });

    const back = within(dialog).getByRole("button", { name: /^back/i });
    const connect = within(dialog).getByRole("button", {
      name: /^connect/i,
    });
    // Close (the Radix X button) is labelled "Close" by the shadcn dialog
    // primitive — it sits inside the dialog root.
    const close = within(dialog).getByRole("button", { name: /close/i });

    for (const btn of [back, connect, close]) {
      btn.focus();
      expect(btn).toHaveFocus();
      // A focusable native button has either no tabindex or tabindex >= 0.
      const ti = btn.getAttribute("tabindex");
      if (ti !== null) {
        expect(Number(ti)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
