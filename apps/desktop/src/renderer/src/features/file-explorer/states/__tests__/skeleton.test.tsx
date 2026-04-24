/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { Skeleton } from "../skeleton";
import type { ViewMode } from "../../store";

describe("Skeleton", () => {
  afterEach(cleanup);

  const MODES: ViewMode[] = [
    "list",
    "details",
    "small",
    "tiles",
    "medium",
    "large",
  ];

  for (const mode of MODES) {
    it(`[${mode}] renders 6 rows/cells, no spinner, aria-hidden root, data-mode`, () => {
      render(<Skeleton mode={mode} />);
      const root = screen.getByTestId("file-explorer-skeleton");
      expect(root.getAttribute("aria-hidden")).toBe("true");
      expect(root.getAttribute("data-mode")).toBe(mode);

      // Count either row containers (list/details) or cells (grid modes).
      // Each row/cell has two or more children; the top-level immediate
      // children count should be exactly 6 for every mode.
      expect(root.children.length).toBe(6);

      // No spinner / "Loading..." text anywhere in the tree.
      expect(root.textContent).toBe("");
      expect(root.querySelector("[role='progressbar']")).toBeNull();
    });
  }
});
