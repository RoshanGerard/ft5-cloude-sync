// Manual smoke-test client. Connects to the running dev service
// (Windows: `\\.\pipe\ft5-sync-dev`; Unix: `$HOME/ft5/sync_app/dev/sync-dev.sock`),
// sends a `sync:get-status` request, prints the first response frame,
// and exits 0 on success / 1 on transport error / 2 on timeout.
// Usage: `node scripts/smoke-client.mjs` with the service running in
// another terminal via `pnpm --filter @ft5/fs-sync-service start -- --dev`.
// Companion doc: SMOKE.md.

import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const pipe =
  process.platform === "win32"
    ? "\\\\.\\pipe\\ft5-sync-dev"
    : path.join(os.homedir(), "ft5/sync_app/dev/sync-dev.sock");

const sock = net.connect(pipe);
let buf = "";

sock.on("connect", () => {
  const frame = {
    id: "1",
    kind: "request",
    command: "sync:get-status",
    params: {},
  };
  sock.write(`${JSON.stringify(frame)}\n`);
});

sock.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  const nl = buf.indexOf("\n");
  if (nl >= 0) {
    const line = buf.slice(0, nl);
    console.log(line);
    sock.end();
    process.exit(0);
  }
});

sock.on("error", (err) => {
  console.error(`connect error: ${err.message}`);
  process.exit(1);
});

setTimeout(() => {
  console.error("timeout waiting for response");
  process.exit(2);
}, 5000);
