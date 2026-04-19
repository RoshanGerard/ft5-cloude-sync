/** @vitest-environment jsdom */
//
// Phase 6.2 — AddDatasourceDialog extensibility test (RED stage).
//
// Codifies the spec scenario: "Extensibility is enforceable, not just
// documented." A hypothetical fourth provider with a new `credentialsSchema`
// value SHALL cause the matching credential form to mount without any edits
// to the dialog shell, picker, or store — only a new form component under
// `features/datasources/credential-forms/`.
//
// Implementation notes:
//   - `vi.mock("@ft5/ipc-contracts", ...)` is hoisted by vitest and file-
//     scoped. It lives in this dedicated file so sibling tests
//     (add-dialog.test.tsx / card.test.tsx / dashboard.test.tsx) do NOT see
//     the fourth provider. We spread `actual` so every type-level export
//     (DatasourceSummary, channels, etc.) stays intact — only `providers`
//     is replaced.
//   - Includes a file-scan assertion that the dialog + picker source code
//     contain NO `providerId === "<literal>"` branches. All branching must
//     go through `descriptor.credentialsSchema`. Mirrors the pattern of
//     scripts/radii-ceiling.test.ts (fs.readFileSync + regex).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@ft5/ipc-contracts", async () => {
  const actual = await vi.importActual<typeof import("@ft5/ipc-contracts")>(
    "@ft5/ipc-contracts",
  );
  return {
    ...actual,
    providers: {
      ...actual.providers,
      dropbox: {
        id: "dropbox",
        displayName: "Dropbox (test)",
        icon: "cloud",
        capabilities: { quota: true, oauth: false, directUpload: true },
        credentialsSchema: "custom" as const,
      },
    },
  };
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FEATURE_ROOT = path.resolve(__dirname, "..");

beforeEach(() => {
  if (!("ResizeObserver" in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class MockResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
  (window as unknown as { api: unknown }).api = {
    ping: vi.fn().mockResolvedValue({ ok: true, ts: 1 }),
    datasources: {
      list: vi.fn().mockResolvedValue({ datasources: [] }),
      add: vi.fn(),
      remove: vi.fn(),
      action: vi.fn(),
      upload: vi.fn(),
      onUploadProgress: vi.fn().mockReturnValue(() => {}),
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AddDatasourceDialog — extensibility (task 6.2)", () => {
  it("registers a 4th provider via registry mock and shows 4 picker options", async () => {
    // Dynamic import AFTER vi.mock is in effect. The providers export visible
    // to the dialog / picker / store will include the dropbox fixture.
    const { DatasourcesProvider } = await import("../store");
    const { DatasourcesDashboard } = await import("../dashboard");

    render(
      <DatasourcesProvider>
        <DatasourcesDashboard />
      </DatasourcesProvider>,
    );

    await screen.findByTestId("datasources-empty");
    fireEvent.click(screen.getByTestId("add-datasource-trigger"));

    const dialog = await screen.findByRole("dialog", {
      name: /add datasource/i,
    });

    // Four options: the three real providers + dropbox fixture.
    const allOptions = within(dialog).getAllByTestId(/^provider-option-/);
    expect(allOptions.length).toBe(4);

    expect(
      within(dialog).getByTestId("provider-option-dropbox"),
    ).toBeInTheDocument();
  });

  it("selecting the fixture provider mounts the custom credential form (dispatched on credentialsSchema)", async () => {
    const { DatasourcesProvider } = await import("../store");
    const { DatasourcesDashboard } = await import("../dashboard");

    render(
      <DatasourcesProvider>
        <DatasourcesDashboard />
      </DatasourcesProvider>,
    );

    await screen.findByTestId("datasources-empty");
    fireEvent.click(screen.getByTestId("add-datasource-trigger"));

    const dialog = await screen.findByRole("dialog", {
      name: /add datasource/i,
    });

    const dropboxOption = within(dialog).getByTestId("provider-option-dropbox");
    fireEvent.click(dropboxOption);

    // The custom form carries a stable testid so the assertion doesn't depend
    // on placeholder copy.
    const customForm = await within(dialog).findByTestId(
      "credential-form-custom",
    );
    expect(customForm).toBeInTheDocument();
  });

  it("dialog and picker source contain NO `providerId === \"...\"` branches", () => {
    // File-scan guardrail: if someone adds a hardcoded provider-id branch,
    // the extensibility contract breaks silently. This test catches it.
    const scanFiles = [
      path.join(FEATURE_ROOT, "add-dialog.tsx"),
      path.join(FEATURE_ROOT, "provider-picker.tsx"),
    ];
    // Matches `providerId === "<lit>"` and `providerId === '<lit>'` with any
    // whitespace in between. Comments are not stripped — a comment containing
    // the literal form would also be flagged, which is the intent (the
    // pattern must not appear in any conditional position).
    const forbidden = /providerId\s*===\s*["'][^"']+["']/;

    for (const file of scanFiles) {
      const text = readFileSync(file, "utf8");
      expect(
        forbidden.test(text),
        `Expected ${path.relative(FEATURE_ROOT, file)} to contain no \`providerId === "..."\` branches — extensibility requires dispatch on credentialsSchema.`,
      ).toBe(false);
    }
  });
});
