// §7 — committed `services/fs-sync/config.example.json` template invariants.
//
// Per the fs-sync-service spec (Modified Requirement "ServiceConfigStore reads
// `~/ft5/sync_app/config.json` for OAuth app config"), the repo ships a
// committed template at `services/fs-sync/config.example.json` so the
// first-run setup is `cp services/fs-sync/config.example.json
// ~/ft5/sync_app/config.json` followed by editing the file.
//
// This test pins the template's invariants:
//   - file exists at the documented path
//   - parseable JSON
//   - schemaVersion === 1
//   - providers map contains google-drive AND onedrive
//   - both entries have empty-string clientId/clientSecret (so the user is
//     forced to fill them in; nothing in the committed template ever points
//     at a real GCP / Azure registration)
//   - amazon-s3 is intentionally absent (S3 uses access keys, not OAuth, so
//     no app registration concern lives here)

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

// __dirname is `services/fs-sync/src/__tests__`; the committed template
// lives at `services/fs-sync/config.example.json` — three levels up.
const TEMPLATE_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "config.example.json",
);

describe("services/fs-sync/config.example.json template", () => {
  it("exists at the documented path", async () => {
    await expect(fsp.access(TEMPLATE_PATH)).resolves.toBeUndefined();
  });

  it("is valid JSON with schemaVersion=1 and a providers object", async () => {
    const raw = await fsp.readFile(TEMPLATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as {
      schemaVersion: number;
      providers: Record<string, unknown>;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(typeof parsed.providers).toBe("object");
    expect(parsed.providers).not.toBeNull();
  });

  it("contains google-drive and onedrive provider entries with empty-string credentials", async () => {
    const raw = await fsp.readFile(TEMPLATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as {
      providers: Record<string, { clientId: string; clientSecret: string }>;
    };
    expect(parsed.providers["google-drive"]).toEqual({
      clientId: "",
      clientSecret: "",
    });
    expect(parsed.providers["onedrive"]).toEqual({
      clientId: "",
      clientSecret: "",
    });
  });

  it("intentionally omits amazon-s3 (no OAuth app registration for access-key auth)", async () => {
    const raw = await fsp.readFile(TEMPLATE_PATH, "utf8");
    const parsed = JSON.parse(raw) as {
      providers: Record<string, unknown>;
    };
    expect(parsed.providers["amazon-s3"]).toBeUndefined();
  });
});
