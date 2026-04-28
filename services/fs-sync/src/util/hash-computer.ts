// Streaming hash computer used by the `files:download` handler's
// post-download integrity check (per add-engine-rename-download §13.14
// + design.md Decision 3 step 8). Implements the `HashComputer`
// interface declared in `commands/files-download.ts` for the three
// algorithms `node:crypto` ships natively — `md5`, `sha1`, `sha256`.
//
// Naming note. There is already a `services/fs-sync/src/executors/
// hasher.ts` that exposes a single `hashFileSha256(path)` for the upload
// executor's mtime-changed-recompute path. That helper predates §13 and
// is sha256-only; rather than retro-fit it to a polymorphic API and
// risk a behavioural change in the unrelated upload path, this module
// is built fresh against the `HashComputer` contract `files-download.ts`
// asserts on. Both modules ultimately wrap `node:crypto.createHash` over
// a `createReadStream`.
//
// Algorithm coverage. The interface admits `md5 | sha1 | sha256`. Drive
// advertises `md5Checksum`, OneDrive advertises `sha1Hash` /
// `sha256Hash`, and S3 advertises `ETag` (md5 for single-part). OneDrive's
// `quickXorHash` is NOT implementable in `node:crypto` and is treated as
// "not advertised" by `readProviderHash` upstream — the handler skips
// the integrity check entirely in that case, so this module never sees
// a `quickXorHash` request.
//
// Output format. `node:crypto`'s `digest("hex")` returns lowercase hex
// already; `readProviderHash` lowercases the provider's value before
// comparison (see `files-download.ts` line 649: `localDigest.toLowerCase()
// !== providerHash.digest`). Both sides are lowercase by construction —
// the integrity check is a stable string equality.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import type {
  HashComputer,
  IntegrityAlgo,
} from "../commands/files-download.js";

/**
 * Default `HashComputer` implementation. Streams the file at `path`
 * through `node:crypto.createHash(algo)` and resolves with the digest as
 * a lowercase hex string. A 10+ MB file does not get fully loaded into
 * memory — the stream pipes chunks directly into the hash.
 *
 * The factory is parameterless and the returned object is stateless
 * (each `hashFile` call opens its own read stream), so production
 * bootstrap can construct a single shared instance and pass it through
 * to every `files:download` invocation without contention.
 */
export function createHashComputer(): HashComputer {
  return {
    hashFile(path: string, algo: IntegrityAlgo): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const hash = createHash(algo);
        const stream = createReadStream(path);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", (err) => reject(err));
      });
    },
  };
}
