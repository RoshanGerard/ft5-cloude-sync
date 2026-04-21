// Streaming SHA-256 hasher. Consumes files via ReadStream so a 10+ MB file
// does not get loaded into memory.
//
// Spec: "Changed mtime triggers hash then upload on hash mismatch" scenario.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function hashFileSha256(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}
