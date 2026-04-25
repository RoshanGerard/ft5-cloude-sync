// Task 9.1 — type-only stub for the per-job Sonner upload toaster.
//
// This file exposes the public surface that the orchestrator (Task 5)
// will plug into in 9.2. The body throws so any accidental wiring before
// 9.2 lands fails loudly. The matching test file
// (./__tests__/upload-job-toast.test.ts) drives the contract:
//   (a) onJobDispatched subscribes to progress + opens a loading toast
//   (b) progress events update the same toast id with %-complete text
//   (c) terminal `completed` -> success toast, duration 4000, unsubscribe
//   (d) terminal `failed` -> error toast with Retry action, no auto-dismiss
//   (e) clicking Retry calls dispatch.retry(), unsubscribes old feed,
//       dismisses the old toast id
//   (f) onBatchError -> toast.error with no jobId tracking
//   (g) two concurrent onJobDispatched calls -> two independent toasts;
//       events for one don't affect the other.

import type { DatasourcesUploadProgressEvent } from "@ft5/ipc-contracts";

import type { UploadToaster } from "./use-upload-orchestrator.js";

// Toast api the helper uses (subset of sonner's `toast`). Injected for
// tests; production falls back to `import { toast } from "sonner"`.
export interface ToastApi {
  loading(
    message: string,
    opts?: { id?: string | number; duration?: number },
  ): string | number;
  success(
    message: string,
    opts?: { id?: string | number; duration?: number },
  ): string | number;
  error(
    message: string,
    opts?: {
      id?: string | number;
      duration?: number;
      action?: { label: string; onClick: () => void };
    },
  ): string | number;
  dismiss(id: string | number): void;
}

// Subscription api keyed by transactionId (≡ jobId from files.upload).
// Returns an unsubscribe fn. Injected for tests; production falls back
// to `window.api.datasources.onUploadProgress`.
export interface UploadProgressApi {
  onUploadProgress(
    transactionId: string,
    callback: (event: DatasourcesUploadProgressEvent) => void,
  ): () => void;
}

export interface UploadToasterDeps {
  readonly toast?: ToastApi;
  readonly progressApi?: UploadProgressApi;
}

export function createUploadJobToaster(
  _deps?: UploadToasterDeps,
): UploadToaster {
  throw new Error("not implemented (Task 9.2)");
}
