# Proposal: Service-level single-instance enforcement for desktop clients

**Status**: Stub. Spawned by Risk 4 in
`add-engine-rename-download`'s `design.md` on 2026-04-27.

## Why

The fs-sync service is a detached process that survives desktop app
close. It accepts client connections on a named pipe / socket
(`\\.\pipe\ft5-sync` on Windows; `~/ft5/sync_app/sync.sock` on Unix).
Today the service accepts **any number of concurrent desktop client
connections** — a second desktop instance can connect alongside the
first and issue commands independently.

Risk surfaced during `add-engine-rename-download` brainstorming:

- **Concurrent rename of the same entry.** Two desktop instances each
  issue a rename on the same `(datasourceId, path)`. The engine has no
  cross-process locking; one succeeds, the other gets a provider
  not-found. Acceptable today as a "rare race" but structurally
  preventable.
- **Concurrent download orchestration.** Two desktops both query
  `downloads:list-active`; both spawn toasts for the same in-flight
  job; cancel from one races the other.
- **Future surfaces** (auth-cancel, settings-set-config, registry-add)
  carry similar concurrency concerns as more service surfaces ship.

The fix is structural: the service enforces an "at most one active
desktop client" invariant. A second connection arriving while the
first is alive is rejected with a typed `another-instance-active`
error. The desktop main process surfaces this as a blocking overlay
("Another instance is already running") with an Exit button that
calls `app.quit()`.

This is service-layer defense-in-depth alongside Electron's
`app.requestSingleInstanceLock()` (which enforces single-instance at
the BrowserWindow level). The service-layer check works regardless of
how the client was launched (Electron, programmatic test harness,
malicious local script).

## Out of scope

- Auth/authz on the IPC channel beyond the existing OS-user-only
  socket permissions (mode 0600 on Unix, user ACL on Windows).
  Single-instance enforcement is about RACE prevention, not security.
- Multi-account / multi-user support. The service is per-user; one
  user, one service, one client. Multi-user would change the data dir
  layout and the supervisor protocol — that's a separate change.
- Programmatic test harness multi-connect. Tests that spawn a service
  and connect from multiple test workers may need a per-test
  data-dir override (the existing `FT5_SYNC_DATA_DIR` mechanism) to
  spawn separate service instances.

## Open questions (resolve during `/opsx:propose`)

1. **Reconnect window semantics (chosen during brainstorming: option β).**
   The supervisor reconnects on transient pipe disconnects. The service
   needs to distinguish "same instance reconnecting" from "new instance
   launching." Option β: a 30-second silence-timeout on the existing
   connection. If the existing connection has had no activity for
   >30s when a new client tries to connect, treat the existing as
   abandoned and accept the new one. Shorter than 30s causes false
   "abandoned" decisions during long-running engine ops; longer than
   30s makes the locked-out experience worse for users with a hung
   prior instance.

   Alternatives if β proves wrong: α (strict — any 2nd connection
   rejects), γ (session token persisted on disk).

2. **What counts as "activity" for the 30s timer?** Wire-level frames?
   Application-level requests? A periodic keepalive heartbeat the
   client must send? Recommend wire-level frames (any received byte
   resets the timer); avoids needing a new heartbeat protocol.

3. **Renderer overlay UX.** When the desktop main process receives
   `another-instance-active` from supervisor.connect, the new instance
   SHALL render a blocking overlay with copy "Another instance of
   ft5-cloude-sync is already running" and an Exit button that calls
   `app.quit()`. Open: should the existing instance receive any
   notification ("hey, someone tried to launch you")? Recommend no —
   the existing instance just stays as-is.

4. **Interaction with Electron's `app.requestSingleInstanceLock()`.**
   If Electron's lock is already held by the existing app, the second
   instance never reaches the supervisor at all. If Electron's lock
   is bypassed somehow (debug builds, separate `userData` dirs), the
   service-layer check catches it. Both layers in place: belt-and-
   suspenders.

5. **How does the service detect a stale connection?** Three options:
   (a) Socket-error detection on idle reads (the OS surfaces ECONNRESET
       when a peer process dies); reliable on Unix, less reliable on
       Windows named pipes.
   (b) Application-level heartbeat: client sends a ping every 10s;
       service expires the connection after 30s of no ping.
   (c) Last-frame-timestamp tracking: any received frame resets the
       timer; no explicit heartbeat needed (assumes the client is
       active enough to send something every 30s — long-idle
       sessions need a fallback).
   Recommend (a) + (c) — socket-error catches dead peers fast on
   Unix; last-frame timer covers the slow-drift case + Windows.

## Acceptance criteria (once promoted)

- Service maintains a single "active desktop connection" slot in its
  connection-tracking state. Second connection while one is alive →
  `another-instance-active` typed error + immediate close.
- 30-second silence timeout on the existing connection per option β.
  Exhaustive tests for the reconnect window: connection drops at
  t=0, supervisor reconnects at t=2s (allowed); connection drops at
  t=0, new instance connects at t=35s after no activity (treated as
  abandoned, allowed).
- Desktop main process catches the `another-instance-active` error
  from supervisor.connect and renders a blocking overlay with an
  Exit button. Activating Exit calls `app.quit()`. The overlay
  cannot be dismissed by other means.
- Documentation in `apps/desktop/CLAUDE.md` (or equivalent) noting
  the dual layer (Electron lock + service lock) and the 30s timeout
  behavior.

## Provenance

- Spawned by Risk 4 in `add-engine-rename-download` design.md on
  2026-04-27 (concurrent rename of same entry).
- Reconnect window strategy β (30s timeout) confirmed by the user
  during the same brainstorming session.
- Renderer overlay UX (Exit button calls `app.quit()`) was the
  user's explicit framing.
