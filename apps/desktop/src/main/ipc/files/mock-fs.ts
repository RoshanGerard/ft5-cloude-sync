import type {
  FileEntry,
  FilesListRequest,
  FilesListResponse,
  FilesRemoveRequest,
  FilesRemoveResponse,
  FilesSearchRequest,
  FilesSearchResponse,
  FilesStatRequest,
  MimeFamily,
} from "@ft5/ipc-contracts";
import {
  FILES_PROVIDER_SEARCH_DEFERRED_MESSAGE,
  FilesErrorTag,
} from "@ft5/ipc-contracts";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Upper bound on the number of matches the S3 client-side search scan will
 * return in v1. When the underlying match set exceeds this number the response
 * is reported as `truncated: true` so the UI can surface a partial-results
 * notice. Kept modest on purpose — the in-memory fixture is small and the real
 * provider-backed handler will drive its own ceiling.
 */
export const SEARCH_RESULT_CEILING = 50;

/** Per-directory seed ceiling enforced by design.md Decision 10. */
const DIRECTORY_SIZE_CEILING = 300;

// Deterministic timestamps — tests asserting response shape must not hit a
// fresh `Date.now()` on every reset.
const SEED_EPOCH_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

// -----------------------------------------------------------------------------
// Mime-family derivation (canonical; renderer must not parse extensions)
// -----------------------------------------------------------------------------

function mimeFamilyFor(name: string): MimeFamily {
  const lower = name.toLowerCase();
  // Test the compound extension before individual tail parts.
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "archive";

  const dot = lower.lastIndexOf(".");
  if (dot === -1) return "unknown";
  const ext = lower.slice(dot);

  switch (ext) {
    case ".jpg":
    case ".jpeg":
    case ".png":
    case ".gif":
    case ".webp":
    case ".svg":
    case ".bmp":
      return "image";
    case ".mp4":
    case ".mov":
    case ".mkv":
    case ".webm":
    case ".avi":
      return "video";
    case ".mp3":
    case ".wav":
    case ".flac":
    case ".m4a":
    case ".ogg":
      return "audio";
    case ".pdf":
    case ".docx":
    case ".xlsx":
    case ".pptx":
    case ".odt":
    case ".pages":
      return "document";
    case ".zip":
    case ".tar":
    case ".rar":
    case ".7z":
      return "archive";
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".json":
    case ".py":
    case ".go":
    case ".rs":
    case ".java":
    case ".cpp":
    case ".c":
    case ".h":
    case ".css":
    case ".html":
      return "code";
    case ".txt":
    case ".md":
    case ".log":
      return "text";
    default:
      return "unknown";
  }
}

const MIME_TYPE_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".zip": "application/zip",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

function mimeTypeFor(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    return "application/gzip";
  }
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = lower.slice(dot);
  return MIME_TYPE_BY_EXT[ext] ?? null;
}

// -----------------------------------------------------------------------------
// Seed shape
// -----------------------------------------------------------------------------

interface DatasourceTree {
  // Map of parentPath -> entries directly under that path.
  // The root listing is keyed at "/".
  byParent: Map<string, FileEntry[]>;
}

type Trees = Record<string, DatasourceTree>;

function joinPath(parent: string, name: string): string {
  if (parent === "/") return `/${name}`;
  return `${parent}/${name}`;
}

function makeFileEntry(
  datasourceId: string,
  parentPath: string,
  name: string,
  opts: { size: number; modifiedOffsetMs?: number } = { size: 1024 },
): FileEntry {
  const path = joinPath(parentPath, name);
  const modifiedAt = new Date(
    SEED_EPOCH_MS + (opts.modifiedOffsetMs ?? 0),
  ).toISOString();
  return {
    id: `${datasourceId}::${path}`,
    kind: "file",
    name,
    path,
    parentPath,
    size: opts.size,
    mimeFamily: mimeFamilyFor(name),
    mimeType: mimeTypeFor(name),
    modifiedAt,
    createdAt: modifiedAt,
    providerMetadata: {},
  };
}

function makeDirEntry(
  datasourceId: string,
  parentPath: string,
  name: string,
): FileEntry {
  const path = joinPath(parentPath, name);
  const modifiedAt = new Date(SEED_EPOCH_MS).toISOString();
  return {
    id: `${datasourceId}::${path}`,
    kind: "directory",
    name,
    path,
    parentPath,
    size: null,
    mimeFamily: "unknown",
    mimeType: null,
    modifiedAt,
    createdAt: modifiedAt,
    providerMetadata: {},
  };
}

// -----------------------------------------------------------------------------
// Seed builders
// -----------------------------------------------------------------------------

function addDirectory(
  tree: DatasourceTree,
  datasourceId: string,
  parentPath: string,
  name: string,
  childrenBuilder: (childPath: string) => void,
): FileEntry {
  const entry = makeDirEntry(datasourceId, parentPath, name);
  appendEntry(tree, parentPath, entry);
  // Ensure the directory has an entry listing (possibly empty).
  if (!tree.byParent.has(entry.path)) {
    tree.byParent.set(entry.path, []);
  }
  childrenBuilder(entry.path);
  return entry;
}

function addFile(
  tree: DatasourceTree,
  datasourceId: string,
  parentPath: string,
  name: string,
  opts: { size: number; modifiedOffsetMs?: number },
): FileEntry {
  const entry = makeFileEntry(datasourceId, parentPath, name, opts);
  appendEntry(tree, parentPath, entry);
  return entry;
}

function appendEntry(
  tree: DatasourceTree,
  parentPath: string,
  entry: FileEntry,
): void {
  const existing = tree.byParent.get(parentPath) ?? [];
  existing.push(entry);
  tree.byParent.set(parentPath, existing);
}

function seedDrivePersonal(): DatasourceTree {
  const ds = "ds-gdrive-personal";
  const tree: DatasourceTree = { byParent: new Map([["/", []]]) };

  const files = [
    "welcome.pdf",
    "tax-summary-2025.pdf",
    "resume.docx",
    "budget.xlsx",
    "keynote-notes.md",
  ];
  files.forEach((name, i) =>
    addFile(tree, ds, "/", name, {
      size: 20_000 + i * 3_000,
      modifiedOffsetMs: i * 1000 * 60 * 60 * 24,
    }),
  );

  addDirectory(tree, ds, "/", "documents", (docsPath) => {
    const docFiles = [
      "agenda.docx",
      "minutes-q1.docx",
      "notes.md",
      "report-2026.pdf",
      "checklist.md",
      "memo.odt",
    ];
    docFiles.forEach((n, i) =>
      addFile(tree, ds, docsPath, n, { size: 40_000 + i * 1_500 }),
    );
    addDirectory(tree, ds, docsPath, "2026", (yearPath) => {
      addDirectory(tree, ds, yearPath, "taxes", (taxesPath) => {
        ["w2.pdf", "1099.pdf", "receipts.xlsx", "summary.docx"].forEach(
          (n, i) =>
            addFile(tree, ds, taxesPath, n, { size: 60_000 + i * 4_000 }),
        );
      });
    });
  });

  addDirectory(tree, ds, "/", "projects", (projPath) => {
    [
      "roadmap.pdf",
      "pitch-deck.pptx",
      "estimates.xlsx",
      "retrospective.docx",
      "draft-proposal.pages",
      "feedback-log.md",
      "launch-plan.docx",
      "release-checklist.md",
    ].forEach((n, i) =>
      addFile(tree, ds, projPath, n, { size: 80_000 + i * 2_000 }),
    );
  });

  addDirectory(tree, ds, "/", "presentations", (prPath) => {
    [
      "all-hands-q1.pptx",
      "all-hands-q2.pptx",
      "board-update.pptx",
      "customer-demo.pptx",
      "sales-kickoff.pptx",
    ].forEach((n, i) =>
      addFile(tree, ds, prPath, n, { size: 200_000 + i * 50_000 }),
    );
  });

  addDirectory(tree, ds, "/", "receipts", (rcPath) => {
    for (let i = 0; i < 20; i++) {
      addFile(tree, ds, rcPath, `receipt-${String(i + 1).padStart(3, "0")}.pdf`, {
        size: 5_000 + i * 250,
      });
    }
  });

  return tree;
}

function seedOneDriveWork(): DatasourceTree {
  const ds = "ds-onedrive-work";
  const tree: DatasourceTree = { byParent: new Map([["/", []]]) };

  [
    "welcome.docx",
    "org-chart.pdf",
    "travel-policy.pdf",
    "expense-guide.md",
    "style-guide.md",
  ].forEach((n, i) =>
    addFile(tree, ds, "/", n, { size: 25_000 + i * 1_500 }),
  );

  addDirectory(tree, ds, "/", "Shared with Me", (shPath) => {
    for (let i = 0; i < 18; i++) {
      addFile(tree, ds, shPath, `shared-doc-${i + 1}.docx`, {
        size: 30_000 + i * 1_000,
      });
    }
  });

  addDirectory(tree, ds, "/", "Notebooks", (nbPath) => {
    ["planning.md", "ideas.md", "standups.md", "retros.md"].forEach((n, i) =>
      addFile(tree, ds, nbPath, n, { size: 10_000 + i * 500 }),
    );
  });

  addDirectory(tree, ds, "/", "Downloads", (dlPath) => {
    for (let i = 0; i < 22; i++) {
      addFile(tree, ds, dlPath, `export-${i + 1}.xlsx`, {
        size: 50_000 + i * 1_000,
      });
    }
  });

  addDirectory(tree, ds, "/", "Photos", (phPath) => {
    addDirectory(tree, ds, phPath, "2026-Q1", (qPath) => {
      for (let i = 0; i < 28; i++) {
        addFile(tree, ds, qPath, `IMG_${String(1000 + i).padStart(4, "0")}.jpg`, {
          size: 1_500_000 + i * 50_000,
        });
      }
    });
  });

  return tree;
}

function seedS3Archive(): DatasourceTree {
  const ds = "ds-s3-archive";
  const tree: DatasourceTree = { byParent: new Map([["/", []]]) };

  [
    "README.md",
    "inventory.json",
    "index.html",
    "changelog.log",
    "release-notes.txt",
    "architecture.png",
  ].forEach((n, i) =>
    addFile(tree, ds, "/", n, { size: 10_000 + i * 500 }),
  );

  addDirectory(tree, ds, "/", "backups", (bkPath) => {
    for (let i = 0; i < 12; i++) {
      addFile(tree, ds, bkPath, `snapshot-2026-${String(i + 1).padStart(2, "0")}.tar.gz`, {
        size: 250_000_000 + i * 10_000_000,
      });
    }
    addFile(tree, ds, bkPath, "full-bundle.zip", { size: 900_000_000 });
    addFile(tree, ds, bkPath, "legacy-archive.7z", { size: 120_000_000 });
  });

  addDirectory(tree, ds, "/", "raw-footage", (rfPath) => {
    for (let i = 0; i < 18; i++) {
      addFile(tree, ds, rfPath, `clip-${String(i + 1).padStart(3, "0")}.mp4`, {
        size: 400_000_000 + i * 20_000_000,
      });
    }
    ["reel.mov", "trailer.webm", "stinger.mkv", "bloopers.avi"].forEach((n, i) =>
      addFile(tree, ds, rfPath, n, { size: 300_000_000 + i * 15_000_000 }),
    );
  });

  addDirectory(tree, ds, "/", "assets", (asPath) => {
    addDirectory(tree, ds, asPath, "2025", (yPath) => {
      for (let i = 0; i < 24; i++) {
        addFile(tree, ds, yPath, `asset-${String(i + 1).padStart(3, "0")}.png`, {
          size: 2_000_000 + i * 100_000,
        });
      }
    });
    addDirectory(tree, ds, asPath, "2026", (yPath) => {
      for (let i = 0; i < 24; i++) {
        const ext = i % 3 === 0 ? "jpg" : i % 3 === 1 ? "png" : "webp";
        addFile(tree, ds, yPath, `asset-${String(i + 1).padStart(3, "0")}.${ext}`, {
          size: 2_000_000 + i * 100_000,
        });
      }
      // Add a few audio assets so the search + mime-family coverage widens.
      ["theme.wav", "intro.mp3", "outro.flac", "bed-loop.ogg"].forEach((n) =>
        addFile(tree, ds, yPath, n, { size: 5_000_000 }),
      );
    });
  });

  // Locked-file subdirectory: the partial-failure path for remove().
  addDirectory(tree, ds, "/", "_locked", (lkPath) => {
    addFile(tree, ds, lkPath, "legal-hold.pdf", { size: 80_000 });
    addFile(tree, ds, lkPath, "compliance.zip", { size: 2_500_000 });
  });

  return tree;
}

function seedDriveTeam(): DatasourceTree {
  const ds = "ds-gdrive-team";
  const tree: DatasourceTree = { byParent: new Map([["/", []]]) };

  [
    "team-charter.pdf",
    "roles.docx",
    "roadmap.xlsx",
    "all-hands.pptx",
    "brand-guide.pdf",
    "onboarding.md",
    "escalation-playbook.pdf",
    "vendor-list.xlsx",
    "announcement.md",
    "faq.md",
  ].forEach((n, i) =>
    addFile(tree, ds, "/", n, { size: 30_000 + i * 1_000 }),
  );

  return tree;
}

function buildTrees(): Trees {
  return {
    "ds-gdrive-personal": seedDrivePersonal(),
    "ds-onedrive-work": seedOneDriveWork(),
    "ds-s3-archive": seedS3Archive(),
    "ds-gdrive-team": seedDriveTeam(),
  };
}

function assertCeilings(trees: Trees): void {
  for (const [datasourceId, tree] of Object.entries(trees)) {
    for (const [path, entries] of tree.byParent) {
      if (entries.length > DIRECTORY_SIZE_CEILING) {
        throw new Error(
          `mock-fs seed exceeded ceiling: ${datasourceId} ${path} has ${String(entries.length)} entries (max ${String(DIRECTORY_SIZE_CEILING)})`,
        );
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Mutable module state
// -----------------------------------------------------------------------------

let trees: Trees = buildTrees();
assertCeilings(trees);

// Track which datasources use S3-style searches. Everything else is deferred
// in v1 per Decision 6.
const S3_DATASOURCES = new Set(["ds-s3-archive"]);

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export function resetMockFs(): void {
  trees = buildTrees();
  assertCeilings(trees);
}

export function getFileTree(datasourceId: string): FileEntry[] {
  const tree = trees[datasourceId];
  if (!tree) return [];
  // Flatten every directory into a single list (breadth-first) for callers
  // that want the whole datasource's entries — search / enumeration rely on
  // this. Directory entries are included so consumers can still tell folders
  // apart.
  const out: FileEntry[] = [];
  for (const entries of tree.byParent.values()) {
    for (const entry of entries) {
      out.push(entry);
    }
  }
  return out;
}

export function list(req: FilesListRequest): FilesListResponse {
  const tree = trees[req.datasourceId];
  if (!tree) {
    // Unknown datasourceId becomes a command-level error so the renderer can
    // surface a targeted "reconnect" prompt; the mock has no authentication
    // to revoke, so `tag: "other"` is the honest mapping.
    return {
      ok: false,
      error: {
        tag: FilesErrorTag.Other,
        message: `datasource not found: ${req.datasourceId}`,
        retryable: false,
      },
    };
  }
  const entries = tree.byParent.get(req.path) ?? [];
  return {
    ok: true,
    // mock-fs has no provider paging — every list is a single complete page,
    // so nextCursor is unconditionally null (and truncated stays false).
    value: { entries: entries.map(cloneEntry), truncated: false, nextCursor: null },
  };
}

export function stat(req: FilesStatRequest): FileEntry {
  // Returns the raw FileEntry — the handler wraps it into FilesStatResponse.
  const tree = trees[req.datasourceId];
  if (!tree) throw new Error(`not found: ${req.datasourceId}:${req.path}`);
  const found = findEntry(tree, req.path);
  if (!found) throw new Error(`not found: ${req.datasourceId}:${req.path}`);
  return cloneEntry(found);
}

export function remove(req: FilesRemoveRequest): FilesRemoveResponse {
  const tree = trees[req.datasourceId];
  const results: Array<
    | { path: string; handle: string; ok: true }
    | {
        path: string;
        handle: string;
        ok: false;
        error: { tag: "other"; message: string };
      }
  > = [];

  if (!tree) {
    // Whole-batch rejection: no path was attempted. Command-level error
    // carries the tagged envelope; per-path `results` stays empty.
    return {
      ok: false,
      error: {
        tag: FilesErrorTag.Other,
        message: `datasource not found: ${req.datasourceId}`,
        retryable: false,
      },
    };
  }

  // Mock-fs is path-based (no handle ambiguity on an in-memory tree), so
  // the new `targets` shape is read by destructuring `.path` off each one.
  // The caller-supplied `handle` is echoed back in each result so the
  // renderer's optimistic update can correlate by entry id (same as the
  // real engine-backed path).
  for (const reqTarget of req.targets) {
    const path = reqTarget.path;
    const handle = reqTarget.handle;
    // Any path under /_locked/ fails with the fixed reason — partial-failure
    // code path.
    if (path.startsWith("/_locked/") || path === "/_locked") {
      results.push({
        path,
        handle,
        ok: false,
        error: { tag: FilesErrorTag.Other, message: "provider locked the file" },
      });
      continue;
    }
    const target = findEntry(tree, path);
    if (!target) {
      results.push({
        path,
        handle,
        ok: false,
        error: { tag: FilesErrorTag.Other, message: "not found" },
      });
      continue;
    }
    if (target.kind === "directory") {
      results.push({
        path,
        handle,
        ok: false,
        error: {
          tag: FilesErrorTag.Other,
          message: "directory removal is not supported",
        },
      });
      continue;
    }
    const siblings = tree.byParent.get(target.parentPath);
    if (!siblings) {
      results.push({
        path,
        handle,
        ok: false,
        error: { tag: FilesErrorTag.Other, message: "not found" },
      });
      continue;
    }
    const idx = siblings.findIndex((e) => e.path === path);
    if (idx === -1) {
      results.push({
        path,
        handle,
        ok: false,
        error: { tag: FilesErrorTag.Other, message: "not found" },
      });
      continue;
    }
    siblings.splice(idx, 1);
    results.push({ path, handle, ok: true });
  }

  return { ok: true, value: { results } };
}

interface InternalSearchResult {
  entries: FileEntry[];
  truncated: boolean;
  providerSearchDeferred: boolean;
}

function internalSearch(req: FilesSearchRequest): InternalSearchResult {
  const tree = trees[req.datasourceId];
  if (!tree) {
    return { entries: [], truncated: false, providerSearchDeferred: false };
  }
  if (!S3_DATASOURCES.has(req.datasourceId)) {
    // Drive / OneDrive: native search deferred per Decision 6.
    return { entries: [], truncated: true, providerSearchDeferred: true };
  }

  const needle = req.query.toLowerCase();
  const scope = normalizeSearchScope(req.path);
  const matches: FileEntry[] = [];
  for (const entries of tree.byParent.values()) {
    for (const entry of entries) {
      if (entry.kind !== "file") continue;
      if (scope !== "/" && !entry.path.startsWith(scope)) continue;
      if (needle === "" || entry.name.toLowerCase().includes(needle)) {
        matches.push(entry);
      }
    }
  }
  const truncated = matches.length > SEARCH_RESULT_CEILING;
  const limited = truncated ? matches.slice(0, SEARCH_RESULT_CEILING) : matches;
  return {
    entries: limited.map(cloneEntry),
    truncated,
    providerSearchDeferred: false,
  };
}

export function search(req: FilesSearchRequest): FilesSearchResponse {
  const result = internalSearch(req);
  if (result.providerSearchDeferred) {
    // The legacy `providerSearchDeferred: true` sentinel becomes an
    // `ok: false` envelope with `tag: "other"`. The renderer will need to
    // recognize this message in its error-branch to restore the "provider
    // search not wired" UX — flagged for Section 4.
    return {
      ok: false,
      error: {
        tag: FilesErrorTag.Other,
        message: FILES_PROVIDER_SEARCH_DEFERRED_MESSAGE,
        retryable: false,
      },
    };
  }
  return {
    ok: true,
    value: { entries: result.entries, truncated: result.truncated },
  };
}

export function enumerateSeededDirectorySizes(): Array<{
  datasourceId: string;
  path: string;
  size: number;
}> {
  const out: Array<{ datasourceId: string; path: string; size: number }> = [];
  for (const [datasourceId, tree] of Object.entries(trees)) {
    for (const [path, entries] of tree.byParent) {
      out.push({ datasourceId, path, size: entries.length });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Normalize a search scope path so `startsWith` is a clean subtree-prefix
 * check. The root scope (`"/"` or empty) collapses to `"/"`, which callers
 * treat as a "no filter" sentinel. Any other scope is returned with a trailing
 * slash so `/assets/2025` does not also match `/assets/20250-other-folder`.
 */
function normalizeSearchScope(scope: string): string {
  if (scope === "" || scope === "/") return "/";
  return scope.endsWith("/") ? scope : `${scope}/`;
}

function findEntry(tree: DatasourceTree, path: string): FileEntry | null {
  for (const entries of tree.byParent.values()) {
    for (const entry of entries) {
      if (entry.path === path) return entry;
    }
  }
  return null;
}

function cloneEntry(entry: FileEntry): FileEntry {
  return {
    ...entry,
    providerMetadata: { ...entry.providerMetadata },
  };
}
