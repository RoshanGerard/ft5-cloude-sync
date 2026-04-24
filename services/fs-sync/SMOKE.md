# fs-sync-service smoke test

Manual smoke test that the service binds a named pipe / Unix socket, accepts a client connection, answers `sync:get-status` with `ok: true`, and releases its PID guard on shutdown. Covers the same path as the bootstrap / ipc-bind / signals unit tests, but against a real long-lived process — CI should port these steps when the harness is ready.

Captured against commit **3a7723f..65d5625** on branch `feature/wire-fs-sync-service`. Platform verified: **Windows 11** (named-pipe transport). The Unix flow is symmetric and listed below.

## Prerequisites

- Repo checked out at the worktree (`.worktrees/wire-fs-sync-service`) and `pnpm install` run at the root.
- No other fs-sync-service instance running (`$HOME/ft5/sync_app/dev/service-dev.pid` absent, or the PID it names is not live).

## Steps

### 1. Build the service dist

```bash
pnpm --filter @ft5/fs-sync-service build
```

The `start` script runs `node dist/main/index.js`, so a fresh build is required after source edits.

### 2. Start the service in dev mode

In one terminal:

```bash
pnpm --filter @ft5/fs-sync-service start -- --dev
```

The extra `--` is pnpm's argv escape — it forwards `--dev` to the Node process. Expected stdout within ~300 ms:

```
fs-sync-service started (pid=<N>, mode=dev, pipe=\\.\pipe\ft5-sync-dev)
```

On Unix the pipe line will read `pipe=/home/<user>/ft5/sync_app/dev/sync-dev.sock`.

### 3. Send `sync:get-status` via the smoke client

In a second terminal:

```bash
node services/fs-sync/scripts/smoke-client.mjs
```

Expected stdout (single line, JSON):

```json
{"id":"1","kind":"response","ok":true,"result":{"version":"0.0.0","serviceUuid":"","runningJobs":0,"queuedJobs":0,"waitingNetworkJobs":0,"monitorConnected":false}}
```

The client exits 0 on a success response, 1 on transport failure, 2 on a 5-second timeout.

Equivalent one-liner for platforms without the script (Unix):

```bash
printf '{"id":"1","kind":"request","command":"sync:get-status","params":{}}\n' \
  | nc -U "$HOME/ft5/sync_app/dev/sync-dev.sock"
```

Windows doesn't ship `nc` with pipe support; use `smoke-client.mjs` or PowerShell's `NamedPipeClientStream`.

### 4. Stop the service

Graceful (preferred — exercises the signals.ts 5-second grace period and removes the PID file):

- **Terminal 1**: `Ctrl+C` in the terminal running the service.

Programmatic equivalent on **Unix**:

```bash
kill -INT "$(cat "$HOME/ft5/sync_app/dev/service-dev.pid")"
```

**Windows caveat — graceful shutdown is a manual-only step.** Node's `process.kill(pid, "SIGINT")` and `taskkill /F /PID <pid>` both hard-terminate a service running in a different console on Windows. Neither delivers a real SIGINT — [Node docs](https://nodejs.org/api/process.html#processkillpid-signal) state that on Windows "POSIX signals do not exist, the signal argument will be ignored, and the process will be killed forcefully and abruptly (similar to SIGKILL)." Result: `service-dev.pid` is left behind and the next `start` exits 3 (`AlreadyRunningError`) until the stale file is deleted.

Implications:
- The only reliable way to exercise the graceful path on Windows is Ctrl+C in the terminal that launched the service (same-console SIGINT is honored by the Node child).
- Unit-level coverage for the graceful path lives in `services/fs-sync/src/main/signals.test.ts` — it injects an `EventEmitter` as the signal source, which bypasses the Windows signal-delivery limitation.
- For Windows CI, plan on either running the service in-band with the runner's shell (Ctrl+C equivalent available via `GenerateConsoleCtrlEvent`) or falling back to `taskkill /F` + an explicit PID-file cleanup step.

### 5. Verify clean shutdown

After Ctrl+C the service prints:

```
fs-sync-service received SIGINT; shutting down
```

and exits 0 within 5 seconds. The PID file `$HOME/ft5/sync_app/dev/service-dev.pid` must no longer exist. The SQLite files (`sync.db`, `sync.db-shm`, `sync.db-wal`) stay on disk — they hold persisted state for the next start.

## Observed results (last captured run)

| Step | Expected | Observed |
| --- | --- | --- |
| Start | "fs-sync-service started …" on stdout | ✅ `pid=6624, mode=dev, pipe=\\.\pipe\ft5-sync-dev` |
| smoke-client | `ok:true` response frame with `version`, `serviceUuid`, `runningJobs: 0`, `queuedJobs: 0`, `waitingNetworkJobs: 0`, `monitorConnected: false` | ✅ exactly that shape |
| PID file while running | present, contains the service PID | ✅ `service-dev.pid` contained `6624` |
| Graceful shutdown | PID file removed | ⚠ not exercised — Windows blocks cross-console SIGINT delivery (see caveat above); signals.test.ts covers the assertion via an injected `EventEmitter` |

## CI porting notes

- A headless CI run would start the service in the background, `await` a short delay (or tail stdout for the "started" line), invoke `smoke-client.mjs`, assert exit 0, then signal SIGINT.
- On Windows CI, graceful shutdown requires either same-console Ctrl+C (via `GenerateConsoleCtrlEvent`) or accepting `taskkill /F` + explicit PID-file cleanup as the shutdown contract. `process.kill(pid, "SIGINT")` is not equivalent to Ctrl+C on Windows.
- No SDK credentials are required; `sync:get-status` is the only command exercised and it reads only the job-count repository.
